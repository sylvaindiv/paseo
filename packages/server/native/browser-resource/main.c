#include <fcntl.h>

#include <libproc.h>
#include <sys/sysctl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/proc.h>
#include <signal.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>
#include <time.h>

static int identity(int pid, struct proc_bsdinfo *info) {
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == sizeof(*info)
    && info->pbi_uid == getuid();
}
static void quoted(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static const char *env_value(char *p, char *end, const char *key) {
  size_t n = strlen(key);
  while (p < end && *p) {
    size_t len = strnlen(p, end - p);
    if (len == (size_t)(end - p)) break;
    if (len > n && !strncmp(p, key, n) && p[n] == '=') return p+n+1;
    p += len+1;
  }
  return "";
}
static void snapshot(void) {
  int length = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  int *pids = calloc(1, length + 4096);
  if (!pids) exit(1);
  length = proc_listpids(PROC_ALL_PIDS, 0, pids, length + 4096);
  int argmax = 0; size_t size = sizeof(argmax);
  int argmib[] = { CTL_KERN, KERN_ARGMAX };
  if (sysctl(argmib, 2, &argmax, &size, NULL, 0) || argmax <= 0) exit(1);
  char *args = malloc(argmax);
  if (!args) exit(1);
  printf("["); int first = 1;
  for (int i = 0; i < length / (int)sizeof(int); i++) {
    int pid = pids[i]; struct proc_bsdinfo info;
    if (pid <= 1 || !identity(pid, &info) || info.pbi_status == SZOMB) continue;
    struct rusage_info_v4 usage;
    int measured = proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) == 0;
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    proc_pidpath(pid, path, sizeof(path));
    const char *base = strrchr(path, '/'); base = base ? base+1 : path;
    int executable = !strcmp(base, "Google Chrome") || !strcmp(base, "Chromium")
      || !strcmp(base, "chrome") || !strcmp(base, "chrome-headless-shell")
      || !strcmp(base, "headless_shell") || !strcmp(base, "Google Chrome for Testing");
    int argc = 0, debug = 0, profile = 0, external = 0;
    char *env = args; char *end = args;
    int mib[] = { CTL_KERN, KERN_PROCARGS2, pid }; size = argmax;
    if (!sysctl(mib, 3, args, &size, NULL, 0) && size > sizeof(int)) {
      memcpy(&argc, args, sizeof(int)); end = args + size;
      char *p = args + sizeof(int);
      p += strnlen(p, end-p); while (p < end && !*p) p++;
      for (int a = 0; a < argc && p < end; a++) {
        size_t len = strnlen(p, end-p); if (len == (size_t)(end-p)) break;
        if (!strncmp(p, "--remote-debugging-", 19)) debug = 1;
        if (!strncmp(p, "--user-data-dir=", 16) && p[16]) profile = 1;
        if (!strncmp(p, "--type=", 7)) external = 1;
        p += len+1;
      }
      env = p;
    }
    // Only automation roots qualify. Helpers are attributed through their verified root.
    if (!first) putchar(','); first = 0;
    printf("{\"pid\":%d,\"parent\":%d,\"startedAt\":\"%llu:%llu\",\"bytes\":%llu,\"measured\":%s,\"browser\":%s",
      pid, info.pbi_ppid, (unsigned long long)info.pbi_start_tvsec,
      (unsigned long long)info.pbi_start_tvusec,
      measured ? (unsigned long long)usage.ri_phys_footprint : 0,
      measured ? "true" : "false", executable && debug && profile && !external ? "true" : "false");
    printf(",\"uid\":%u,\"executable\":", info.pbi_uid); quoted(path);
    const char *keys[] = {"PASEO_BROWSER_INSTALLATION", "PASEO_BROWSER_OWNER", "AGENT_BROWSER_NAMESPACE", "AGENT_BROWSER_SESSION", "PASEO_DAEMON_GENERATION", "PASEO_DAEMON_SHARED_PROCESS"};
    const char *names[] = {"installation", "owner", "namespace", "session", "generation", "shared"};
    for (int k = 0; k < 6; k++) { printf(",\"%s\":", names[k]); quoted(env_value(env, end, keys[k])); }
    putchar('}');
  }
  puts("]"); fflush(stdout); free(args); free(pids);
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "snapshot")) { snapshot(); return 0; }
  if (argc == 5 && !strcmp(argv[1], "signal")) {
    int pid = atoi(argv[2]); struct proc_bsdinfo info; char start[80];
    if (pid <= 1 || !identity(pid, &info)) return 3;
    snprintf(start, sizeof(start), "%llu:%llu", (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
    if (strcmp(start, argv[3])) return 3;
    int sig = !strcmp(argv[4], "SIGTERM") ? SIGTERM : !strcmp(argv[4], "SIGKILL") ? SIGKILL : 0;
    return sig && !kill(pid, sig) ? 0 : 4;
  }
  if (argc == 3 && !strcmp(argv[1], "watch")) {
    int fd = open(argv[2], O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    if (fd < 0) return 1;
    if (flock(fd, LOCK_EX | LOCK_NB)) return errno == EWOULDBLOCK ? 73 : 1;
    pid_t parent = getppid();
    while (getppid() == parent && parent != 1) {
      struct timespec before, after;
      clock_gettime(CLOCK_MONOTONIC, &before);
      snapshot();
      clock_gettime(CLOCK_MONOTONIC, &after);
      int64_t remaining = 2000000000LL - ((after.tv_sec - before.tv_sec) * 1000000000LL + after.tv_nsec - before.tv_nsec);
      if (remaining > 0) {
        struct timespec delay = { remaining / 1000000000LL, remaining % 1000000000LL };
        nanosleep(&delay, NULL);
      }
    }
    close(fd); return 0;
  }
  return 2;
}
