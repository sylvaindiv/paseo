#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
int main(int argc, char **argv) {
  if (argc > 1) signal(SIGTERM, SIG_IGN);
  volatile char *memory = malloc(32*1024*1024);
  for (int i=0;i<32*1024*1024;i+=4096) memory[i] = 1;
  while(1) sleep(1);
}
