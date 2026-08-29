import type { Handle } from "remix/ui";
import type { IconNode } from "lucide";
import Activity from "lucide/dist/esm/icons/activity.mjs";
import ArrowDown from "lucide/dist/esm/icons/arrow-down.mjs";
import ArrowRight from "lucide/dist/esm/icons/arrow-right.mjs";
import BadgeCheck from "lucide/dist/esm/icons/badge-check.mjs";
import Bell from "lucide/dist/esm/icons/bell.mjs";
import BookOpenText from "lucide/dist/esm/icons/book-open-text.mjs";
import Brain from "lucide/dist/esm/icons/brain.mjs";
import ChevronDown from "lucide/dist/esm/icons/chevron-down.mjs";
import ChevronRight from "lucide/dist/esm/icons/chevron-right.mjs";
import ChevronsUpDown from "lucide/dist/esm/icons/chevrons-up-down.mjs";
import CircleMinus from "lucide/dist/esm/icons/circle-minus.mjs";
import CirclePlus from "lucide/dist/esm/icons/circle-plus.mjs";
import Cpu from "lucide/dist/esm/icons/cpu.mjs";
import CreditCard from "lucide/dist/esm/icons/credit-card.mjs";
import Ellipsis from "lucide/dist/esm/icons/ellipsis.mjs";
import FileDiff from "lucide/dist/esm/icons/file-diff.mjs";
import Folder from "lucide/dist/esm/icons/folder.mjs";
import GitBranch from "lucide/dist/esm/icons/git-branch.mjs";
import KeyRound from "lucide/dist/esm/icons/key-round.mjs";
import LayoutDashboard from "lucide/dist/esm/icons/layout-dashboard.mjs";
import LogOut from "lucide/dist/esm/icons/log-out.mjs";
import MessageSquare from "lucide/dist/esm/icons/message-square.mjs";
import MemoryStick from "lucide/dist/esm/icons/memory-stick.mjs";
import PanelLeft from "lucide/dist/esm/icons/panel-left.mjs";
import PanelRight from "lucide/dist/esm/icons/panel-right.mjs";
import Plus from "lucide/dist/esm/icons/plus.mjs";
import Server from "lucide/dist/esm/icons/server.mjs";
import Settings from "lucide/dist/esm/icons/settings.mjs";
import Sparkles from "lucide/dist/esm/icons/sparkles.mjs";
import Terminal from "lucide/dist/esm/icons/terminal.mjs";
import User from "lucide/dist/esm/icons/user.mjs";
import Wrench from "lucide/dist/esm/icons/wrench.mjs";
import X from "lucide/dist/esm/icons/x.mjs";

export type IconName =
  | "account"
  | "activity"
  | "arrow-down"
  | "arrow-right"
  | "bell"
  | "book-open-text"
  | "brain"
  | "chevron-down"
  | "chevron-right"
  | "chevrons-up-down"
  | "circle-minus"
  | "circle-plus"
  | "cpu"
  | "credit-card"
  | "secrets"
  | "dashboard"
  | "file-diff"
  | "folder"
  | "github"
  | "logout"
  | "message"
  | "memory"
  | "more-horizontal"
  | "panel-left"
  | "panel-right"
  | "plus"
  | "server"
  | "settings"
  | "sparkles"
  | "terminal"
  | "user"
  | "wrench"
  | "x";

export function Icon(handle: Handle<{ name: IconName; size?: number }>) {
  return () => {
    const size = handle.props.size ?? 16;

    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {getIconNodes(handle.props.name).map((node, index) => (
          <LucideNode
            key={index}
            node={node}
          />
        ))}
      </svg>
    );
  };
}

export function createIconElement(name: IconName, size = 16): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [tag, attributes] of getIconNodes(name)) {
    const child = document.createElementNS(namespace, tag);
    for (const [attribute, value] of Object.entries(attributes)) {
      if (value !== undefined) child.setAttribute(attribute, String(value));
    }
    svg.append(child);
  }
  return svg;
}

function LucideNode(handle: Handle<{ node: IconNode[number] }>) {
  return () => {
    const [tag, attributes] = handle.props.node;
    switch (tag) {
      case "circle":
        return <circle {...attributes} />;
      case "line":
        return <line {...attributes} />;
      case "path":
        return <path {...attributes} />;
      case "rect":
        return <rect {...attributes} />;
      default:
        throw new TypeError(`Unsupported Lucide SVG element: ${tag}`);
    }
  };
}

const iconNodes = {
  account: BadgeCheck,
  activity: Activity,
  "arrow-down": ArrowDown,
  "arrow-right": ArrowRight,
  bell: Bell,
  "book-open-text": BookOpenText,
  brain: Brain,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "chevrons-up-down": ChevronsUpDown,
  "circle-minus": CircleMinus,
  "circle-plus": CirclePlus,
  cpu: Cpu,
  "credit-card": CreditCard,
  secrets: KeyRound,
  dashboard: LayoutDashboard,
  "file-diff": FileDiff,
  folder: Folder,
  github: GitBranch,
  logout: LogOut,
  message: MessageSquare,
  memory: MemoryStick,
  "more-horizontal": Ellipsis,
  "panel-left": PanelLeft,
  "panel-right": PanelRight,
  plus: Plus,
  server: Server,
  settings: Settings,
  sparkles: Sparkles,
  terminal: Terminal,
  user: User,
  wrench: Wrench,
  x: X,
} satisfies Record<IconName, IconNode>;

function getIconNodes(name: IconName): IconNode {
  return iconNodes[name];
}
