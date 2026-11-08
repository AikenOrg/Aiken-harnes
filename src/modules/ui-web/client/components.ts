import "@material/web/button/filled-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/button/text-button.js";
import "@material/web/dialog/dialog.js";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/progress/linear-progress.js";
import "@material/web/switch/switch.js";
import "@material/web/tabs/primary-tab.js";
import "@material/web/tabs/tabs.js";
import "@material/web/textfield/outlined-text-field.js";

type Props = Record<string, unknown>;

/** 通常の DOM 要素を作る小さな補助。 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false || value === null) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      node.className = String(value);
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key === "style") {
      Object.assign(node.style, value as Record<string, string>);
    } else if (key in node) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children) node.append(child);
  return node;
}

export type ButtonOptions = {
  variant?: "filled" | "outlined" | "text";
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
};

/** @material/web のボタンを画面から隠すための薄いラッパー。 */
export function createButton(label: string, options: ButtonOptions = {}): HTMLElement {
  const tag =
    options.variant === "outlined"
      ? "md-outlined-button"
      : options.variant === "text"
        ? "md-text-button"
        : "md-filled-button";
  const button = document.createElement(tag) as HTMLElement & { disabled: boolean };
  button.textContent = label;
  button.className = `ui-button ui-button-${options.variant ?? "filled"}${options.className ? ` ${options.className}` : ""}`;
  if (options.title !== undefined) button.title = options.title;
  if (options.disabled === true) button.disabled = true;
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

export type TextFieldOptions = {
  label: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  onInput?: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
};

export type TextField = HTMLElement & {
  value: string;
  disabled: boolean;
};

/** @material/web のテキストフィールドの薄いラッパー。 */
export function createTextField(options: TextFieldOptions): TextField {
  const field = document.createElement("md-outlined-text-field") as TextField;
  field.className = "ui-text-field";
  field.setAttribute("label", options.label);
  if (options.value !== undefined) field.value = options.value;
  if (options.placeholder !== undefined) field.setAttribute("placeholder", options.placeholder);
  if (options.multiline === true) {
    field.setAttribute("type", "textarea");
    field.setAttribute("rows", String(options.rows ?? 3));
  }
  if (options.onInput) {
    field.addEventListener("input", () => options.onInput?.(field.value));
  }
  if (options.onKeyDown) {
    field.addEventListener("keydown", (event) => options.onKeyDown?.(event as KeyboardEvent));
  }
  return field;
}

export type ListItemOptions = {
  headline: string;
  supportingText?: string;
  selected?: boolean;
  indent?: number;
  trailing?: HTMLElement;
  onClick?: () => void;
};

/** @material/web のリスト項目の薄いラッパー。 */
export function createListItem(options: ListItemOptions): HTMLElement {
  const item = document.createElement("md-list-item") as HTMLElement;
  item.className = "ui-list-item";
  item.setAttribute("type", "button");
  item.style.setProperty("--ui-indent", `${options.indent ?? 0}px`);
  const headline = document.createElement("span");
  headline.className = "ui-list-headline";
  headline.textContent = options.headline;
  item.append(headline);
  if (options.supportingText !== undefined) {
    const supporting = document.createElement("span");
    supporting.className = "ui-list-supporting";
    supporting.slot = "supporting-text";
    supporting.textContent = options.supportingText;
    item.append(supporting);
  }
  if (options.trailing) {
    options.trailing.slot = "end";
    item.append(options.trailing);
  }
  if (options.selected === true) {
    item.classList.add("selected");
    item.setAttribute("aria-selected", "true");
  }
  if (options.onClick) item.addEventListener("click", options.onClick);
  return item;
}

export function createList(className = ""): HTMLElement {
  const list = document.createElement("md-list");
  if (className.length > 0) list.className = className;
  return list;
}

export type TabsHandle = {
  element: HTMLElement;
  setActive(index: number): void;
};

/** @material/web のタブ。 */
export function createTabs(
  labels: string[],
  activeIndex: number,
  onChange: (index: number) => void,
): TabsHandle {
  const tabs = document.createElement("md-tabs") as HTMLElement & { activeTabIndex: number };
  tabs.className = "ui-tabs";
  labels.forEach((label, index) => {
    const tab = document.createElement("md-primary-tab");
    tab.textContent = label;
    if (index === activeIndex) tab.setAttribute("active", "");
    tabs.append(tab);
  });
  tabs.addEventListener("change", () => onChange(tabs.activeTabIndex));
  return {
    element: tabs,
    setActive(index) {
      tabs.activeTabIndex = index;
    },
  };
}

export function createLinearProgress(): HTMLElement {
  const progress = document.createElement("md-linear-progress") as HTMLElement & {
    indeterminate: boolean;
  };
  progress.indeterminate = true;
  progress.className = "ui-progress";
  return progress;
}

export function createStatusChip(state: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `status-chip status-${state}`;
  chip.textContent = state;
  return chip;
}

export type SwitchHandle = {
  element: HTMLElement;
  selected: boolean;
};

/** @material/web のスイッチ。 */
export function createSwitch(
  label: string,
  selected: boolean,
  onChange: (value: boolean) => void,
): SwitchHandle {
  const wrapper = document.createElement("label");
  wrapper.className = "ui-switch";
  const control = document.createElement("md-switch") as HTMLElement & { selected: boolean };
  control.selected = selected;
  control.addEventListener("change", () => onChange(control.selected));
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.append(control, text);
  const handle: SwitchHandle = {
    element: wrapper,
    get selected() {
      return control.selected;
    },
    set selected(value: boolean) {
      control.selected = value;
    },
  };
  return handle;
}

export type DialogHandle = {
  element: HTMLElement;
  setContent(options: {
    headline: string;
    supportingText?: string;
    body: Node | string;
    actions: HTMLElement[];
  }): void;
  open(): void;
  close(): void;
  onClosed?: () => void;
};

/** @material/web のダイアログの薄いラッパー。 */
export function createDialog(): DialogHandle {
  const dialog = document.createElement("md-dialog") as HTMLElement & {
    show(): void;
    close(): void;
  };
  const headline = document.createElement("div");
  headline.slot = "headline";
  const content = document.createElement("div");
  content.slot = "content";
  content.className = "ui-dialog-content";
  const actions = document.createElement("div");
  actions.slot = "actions";
  actions.className = "ui-dialog-actions";
  dialog.append(headline, content, actions);

  const handle: DialogHandle = {
    element: dialog,
    setContent(options) {
      headline.textContent = options.headline;
      content.replaceChildren();
      if (options.supportingText !== undefined) {
        const supporting = document.createElement("p");
        supporting.className = "ui-dialog-supporting";
        supporting.textContent = options.supportingText;
        content.append(supporting);
      }
      content.append(options.body);
      actions.replaceChildren(...options.actions);
    },
    open() {
      dialog.show();
    },
    close() {
      dialog.close();
    },
  };
  dialog.addEventListener("closed", () => handle.onClosed?.());
  return handle;
}

export function createEmptyState(text: string): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "ui-empty";
  empty.textContent = text;
  return empty;
}
