import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { Button } from "@getpaseo/plugin/client/ui";
import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Platform, View } from "react-native";
import { projectColors, type ProjectStyles } from "./styles.js";

type MenuColors = PluginScreenProps["theme"]["colors"];
interface MenuItem {
  id?: string;
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
}

export function ProjectMenu({
  anchor,
  title,
  label = "Actions",
  pending,
  close,
  colors,
  styles,
  items,
}: {
  anchor?: HTMLElement;
  title: string;
  label?: string;
  pending: boolean;
  close(): void;
  colors: MenuColors;
  styles: ProjectStyles;
  items: MenuItem[];
}) {
  if (Platform.OS === "web" && anchor && typeof anchor.showPopover === "function") {
    return (
      <MenuPopover anchor={anchor} close={close} colors={colors} label={label}>
        {items.map((item) => (
          <button
            key={item.id ?? item.label}
            type="button"
            role="menuitem"
            className="projets-task-menu-item"
            style={menuItemStyle}
            onClick={item.onPress}
            disabled={pending || item.disabled}
          >
            <Icon name={item.icon} size={16} color={colors.foreground} />
            {item.label}
          </button>
        ))}
      </MenuPopover>
    );
  }
  return (
    <Modal title={title} open onOpenChange={close}>
      <Modal.Content>
        <View style={styles.options}>
          {items.map((item) => (
            <Button
              key={item.id ?? item.label}
              size="sm"
              onPress={item.onPress}
              disabled={pending || item.disabled}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
            </Button>
          ))}
        </View>
      </Modal.Content>
    </Modal>
  );
}

function MenuPopover({
  anchor,
  close,
  colors,
  label,
  children,
}: {
  anchor: HTMLElement;
  close(): void;
  colors: MenuColors;
  label: string;
  children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = popup.current;
    if (!menu) return;
    const viewport = anchor.ownerDocument.documentElement;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      menu.style.left =
        Math.max(
          8,
          Math.min(viewport.clientWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth),
        ) + "px";
      menu.style.top =
        Math.max(
          8,
          rect.bottom + menu.offsetHeight + 8 <= viewport.clientHeight
            ? rect.bottom + 4
            : rect.top - menu.offsetHeight - 4,
        ) + "px";
    };
    menu.showPopover();
    position();
    const resize = new ResizeObserver(position);
    resize.observe(menu);
    anchor.setAttribute("aria-expanded", "true");
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: Event) => {
      if ((event as ToggleEvent).newState === "closed") close();
    };
    menu.addEventListener("toggle", dismiss);
    return () => {
      resize.disconnect();
      anchor.removeAttribute("aria-expanded");
      menu.removeEventListener("toggle", dismiss);
      if (menu.matches(":popover-open")) menu.hidePopover();
    };
  }, [anchor, close]);
  const style = useMemo(
    () => ({
      ...popoverStyle,
      backgroundColor: colors.surface1,
      color: colors.foreground,
      borderColor: colors.border,
      boxShadow: `0 6px 16px color-mix(in srgb, ${projectColors.shadow} 16%, transparent)`,
    }),
    [colors],
  );
  return createPortal(
    <div
      ref={popup}
      popover="auto"
      role="menu"
      aria-label={label}
      style={style}
      onKeyDown={navigateMenu}
    >
      {children}
    </div>,
    anchor.ownerDocument.body,
  );
}

function navigateMenu(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  );
  const index = items.findIndex((button) => button === event.target);
  if (event.key === "Home" || event.key === "End") {
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    return;
  }
  const offset = event.key === "ArrowDown" ? 1 : -1;
  items[(index + offset + items.length) % items.length]?.focus();
}

const popoverStyle = {
  position: "fixed",
  margin: 0,
  inset: "auto",
  minWidth: 172,
  maxWidth: "calc(100vw - 16px)",
  maxHeight: "calc(100vh - 16px)",
  padding: 4,
  border: "1px solid",
  borderRadius: 14,
  fontFamily: "system-ui, sans-serif",
  overflow: "auto",
} as const;

const menuItemStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  textAlign: "left",
  padding: "6px 8px",
  width: "100%",
  border: 0,
  borderRadius: 8,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 14,
  lineHeight: 1.43,
  cursor: "default",
} as const;
