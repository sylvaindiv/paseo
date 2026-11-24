import { InteractiveStateWriter } from "./state-writer";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  Component,
  type ReactNode,
} from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { InteractiveRenderer, getArtifactNames } from "./renderer";
import { useTranslation } from "react-i18next";
import { useFetchQueries } from "@/data/query";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  InteractiveDocumentSchema,
  validateInteractiveSource,
  type InteractiveDocument,
  type InteractiveState,
} from "@getpaseo/protocol/interactive-response";
import type { ToolCallItem } from "@/types/stream";
import { Button } from "@/components/ui/button";
import { describeToolCall } from "@/tool-calls/detail-level/grouping";
import { useInteractiveConversation } from "./context";
import { interactiveToolDocumentId } from "./tool-result";
import { library } from "./library";
import { InteractiveFields } from "./fields";
import { artifactProposal } from "./artifact";
import { styles } from "./styles";
import { sendConversationAction } from "./send";

class RenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function InteractiveResponseCard({
  items,
  height,
}: {
  items: ToolCallItem[];
  height: number;
}) {
  const context = useInteractiveConversation();
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string>();
  const [width, setWidth] = useState(0);
  const measure = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const proposals = items.map((item) => ({
    id: item.id,
    documentId: interactiveToolDocumentId(item),
    status: describeToolCall(item).status,
  }));
  const queries = useFetchQueries<InteractiveDocument>(
    proposals.map(({ id, documentId, status }) => ({
      dataShape: "value",
      staleTimeMs: 0,
      queryKey: ["interactive-response", context?.serverId, context?.agentId, documentId ?? id],
      enabled: !!documentId && !!context?.client && context.supported && status === "completed",
      queryFn: async () => {
        const result = await context!.client!.getInteractiveResponse(context!.agentId, documentId!);
        if (result.error || !result.document)
          throw new Error(result.error ?? t("interactive.loadError"));
        const document = InteractiveDocumentSchema.parse(result.document);
        validateInteractiveSource(document.source);
        return document;
      },
    })),
  );
  const selectedIndex = proposals.findIndex(({ id }) => id === selectedId);
  const firstSuccessIndex = proposals.findIndex(
    ({ documentId, status }) => documentId && status === "completed",
  );
  const activeIndex = selectedIndex >= 0 ? selectedIndex : Math.max(0, firstSuccessIndex);
  const multiple = proposals.length > 1;
  if (!context?.supported) return <Text style={styles.error}>{t("interactive.updateHost")}</Text>;

  return (
    <View style={[styles.card, { height }]} testID="interactive-response-rail">
      {multiple ? (
        <ScrollView
          horizontal
          style={styles.navigation}
          contentContainerStyle={styles.tabs}
          keyboardShouldPersistTaps="handled"
        >
          {proposals.map(({ id }, index) => (
            <ProposalButton
              key={id}
              id={id}
              active={index === activeIndex}
              title={
                queries[index]?.data?.title ?? t("interactive.proposal", { number: index + 1 })
              }
              onSelect={setSelectedId}
            />
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.viewport} onLayout={measure}>
        <View style={[styles.pages, { transform: [{ translateX: -activeIndex * width }] }]}>
          {proposals.map(({ id, documentId, status }, index) => (
            <View key={id} style={[styles.page, { width: width || "100%" }]}>
              <ScrollView
                style={[styles.pageScroll, index !== activeIndex && styles.hidden]}
                contentContainerStyle={styles.pageContent}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                testID="interactive-response"
              >
                <Proposal
                  documentId={documentId}
                  status={status}
                  query={queries[index]!}
                  artifactHeight={height > 0 ? Math.round(height * 0.78) : undefined}
                  showTitle={!multiple}
                />
              </ScrollView>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const SELECTED = { selected: true };
const UNSELECTED = { selected: false };

function ProposalButton({
  id,
  active,
  title,
  onSelect,
}: {
  id: string;
  active: boolean;
  title: string;
  onSelect: (id: string) => void;
}) {
  const onPress = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <Button
      size="sm"
      variant={active ? "secondary" : "ghost"}
      accessibilityState={active ? SELECTED : UNSELECTED}
      aria-pressed={active}
      onPress={onPress}
    >
      {title}
    </Button>
  );
}

function Proposal({
  documentId,
  status,
  query,
  artifactHeight,
  showTitle,
}: {
  documentId: string | null;
  status: ReturnType<typeof describeToolCall>["status"];
  query: UseQueryResult<InteractiveDocument, Error>;
  artifactHeight?: number;
  showTitle: boolean;
}) {
  const { t } = useTranslation();
  const { refetch } = query;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (status === "running" || status === "executing")
    return <Text style={styles.muted}>{t("interactive.generating")}</Text>;
  if (status !== "completed" || !documentId)
    return (
      <Text accessibilityRole="alert" style={styles.error}>
        {t("interactive.generationError")}
      </Text>
    );
  if (query.isError)
    return (
      <View>
        <Text accessibilityRole="alert" style={styles.error}>
          {String(query.error.message)}
        </Text>
        <Button size="sm" onPress={reload}>
          {t("interactive.retry")}
        </Button>
      </View>
    );
  if (!query.data) return <Text style={styles.muted}>{t("interactive.loading")}</Text>;
  return (
    <DocumentView
      key={`${documentId}:${query.dataUpdatedAt}`}
      document={query.data}
      reload={reload}
      artifactHeight={artifactHeight}
      showTitle={showTitle}
    />
  );
}
function DocumentView({
  document,
  reload,
  artifactHeight,
  showTitle,
}: {
  document: InteractiveDocument;
  reload: () => unknown;
  artifactHeight?: number;
  showTitle: boolean;
}) {
  const context = useInteractiveConversation()!;
  const { t } = useTranslation();
  const [state, setState] = useState(document.state);
  const artifactNames = useMemo(() => getArtifactNames(document.source), [document.source]);
  const latestState = useRef(document.state);
  const blocked = useRef(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "queued">("idle");
  const request = useRef<{
    id: string;
    text: string;
    interactiveReference: { documentId: string; revision: number };
  } | null>(null);
  const sending = useRef(false);
  const runtimes = useRef(new Set<() => Promise<void>>());
  const registerRuntime = useCallback((flush: () => Promise<void>) => {
    runtimes.current.add(flush);
    return () => {
      runtimes.current.delete(flush);
    };
  }, []);
  const alive = useRef(true);
  const [writer] = useState(
    () =>
      new InteractiveStateWriter(
        document.revision,
        async (revision, next) => {
          const result = await context.client!.updateInteractiveResponse(
            context.agentId,
            document.id,
            revision,
            next,
          );
          if (result.error || !result.document)
            throw new Error(result.error ?? t("interactive.saveError"));
          return result.document.revision;
        },
        (failure) => {
          blocked.current = true;
          if (alive.current) setError(failure.message);
        },
      ),
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const change = useCallback(
    (name: string, value: string | number) => {
      if (blocked.current || context.readOnly || status !== "idle" || request.current) return;
      const next: InteractiveState = { ...latestState.current, [name]: value };
      latestState.current = next;
      setState(next);
      writer.write(next);
    },
    [context.readOnly, status, writer],
  );
  const send = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    try {
      const results = await Promise.allSettled(Array.from(runtimes.current, (flush) => flush()));
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      await writer.flush();
      if (blocked.current) throw new Error(t("interactive.reloadConflict"));
      request.current ??= {
        id: crypto.randomUUID(),
        text:
          artifactProposal(latestState.current, artifactNames) ||
          `${document.title} — ${document.summary}\n${Object.entries(latestState.current)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join("\n")}`,
        interactiveReference: { documentId: document.id, revision: writer.revision },
      };
      setStatus(await sendConversationAction(context, request.current));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }, [context, document, t, writer, artifactNames]);
  const retry = useCallback(() => {
    if (blocked.current) reload();
    else void send();
  }, [reload, send]);
  const fields = useMemo(
    () => ({
      state,
      change,
      registerRuntime,
      artifactHeight,
      disabled: context.readOnly || pending || status !== "idle" || Boolean(error),
    }),
    [state, change, registerRuntime, artifactHeight, context.readOnly, pending, status, error],
  );
  const fallback = useMemo(
    () => (
      <Text accessibilityRole="alert" style={styles.error}>
        {t("interactive.renderError")}
      </Text>
    ),
    [t],
  );
  const proposal = artifactProposal(state, artifactNames);
  const label = status === "idle" ? "interactive.send" : (`interactive.${status}` as const);
  return (
    <View style={styles.content}>
      {showTitle ? <Text style={styles.title}>{document.title}</Text> : null}
      <Text style={styles.muted}>{document.summary}</Text>
      <RenderBoundary fallback={fallback}>
        <InteractiveFields.Provider value={fields}>
          <InteractiveRenderer source={document.source} library={library} />
        </InteractiveFields.Provider>
      </RenderBoundary>
      {proposal ? <Text style={styles.text}>{proposal}</Text> : null}
      <View style={styles.row}>
        {!context.readOnly ? (
          <Button
            size="sm"
            onPress={send}
            loading={pending}
            disabled={status !== "idle" || !context.client}
          >
            {t(label)}
          </Button>
        ) : null}
      </View>
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Button size="sm" variant="ghost" onPress={reload}>
            {t("interactive.reload")}
          </Button>
          {!blocked.current ? (
            <Button size="sm" onPress={retry}>
              {t("interactive.retry")}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
