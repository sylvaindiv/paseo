import React, { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExpandableBadge } from "@/components/message";
import { type OverviewToolCallGroup } from "./model";

interface OverviewGroupProps {
  group: OverviewToolCallGroup;
  expanded: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children: ReactNode;
}

const TOOL_CALL_GROUP_MAX_HEIGHT = 400;

function useActionCount(count: number): string {
  const { t } = useTranslation();
  return useMemo(
    () => t(`toolCallGroup.actionCount.${count === 1 ? "one" : "other"}`, { count }),
    [count, t],
  );
}

export const OverviewToolCallGroupView = memo(function OverviewToolCallGroupView({
  group,
  expanded,
  isLastInSequence,
  onExpandedChange,
  children,
}: OverviewGroupProps) {
  const scrollRef = useRef<ScrollView>(null);
  const label = useActionCount(group.run.calls.length);
  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  const toggle = useCallback(() => {
    onExpandedChange(group.run.id, !expanded);
  }, [expanded, group.run.id, onExpandedChange]);
  const renderDetails = useCallback(
    () => (
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        onContentSizeChange={scrollToLatest}
      >
        {children}
      </ScrollView>
    ),
    [children, scrollToLatest],
  );

  return (
    <ExpandableBadge
      testID="tool-call-group"
      label={label}
      icon={Wrench}
      isLoading={group.isLoading}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
      borderlessWhenExpanded
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  scroll: {
    maxHeight: TOOL_CALL_GROUP_MAX_HEIGHT,
  },
  content: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: 13,
  },
}));
