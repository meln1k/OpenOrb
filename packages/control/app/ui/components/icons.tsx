import type { Handle } from "remix/ui";
import type { IconNode } from "lucide";
import ArrowRight from "lucide/dist/esm/icons/arrow-right.mjs";
import BadgeCheck from "lucide/dist/esm/icons/badge-check.mjs";
import Bell from "lucide/dist/esm/icons/bell.mjs";
import ChevronDown from "lucide/dist/esm/icons/chevron-down.mjs";
import ChevronsUpDown from "lucide/dist/esm/icons/chevrons-up-down.mjs";
import Cpu from "lucide/dist/esm/icons/cpu.mjs";
import CreditCard from "lucide/dist/esm/icons/credit-card.mjs";
import Ellipsis from "lucide/dist/esm/icons/ellipsis.mjs";
import Folder from "lucide/dist/esm/icons/folder.mjs";
import GitBranch from "lucide/dist/esm/icons/git-branch.mjs";
import KeyRound from "lucide/dist/esm/icons/key-round.mjs";
import LayoutDashboard from "lucide/dist/esm/icons/layout-dashboard.mjs";
import LogOut from "lucide/dist/esm/icons/log-out.mjs";
import MessageSquare from "lucide/dist/esm/icons/message-square.mjs";
import MemoryStick from "lucide/dist/esm/icons/memory-stick.mjs";
import PanelLeft from "lucide/dist/esm/icons/panel-left.mjs";
import Plus from "lucide/dist/esm/icons/plus.mjs";
import Server from "lucide/dist/esm/icons/server.mjs";
import Settings from "lucide/dist/esm/icons/settings.mjs";
import Sparkles from "lucide/dist/esm/icons/sparkles.mjs";
import User from "lucide/dist/esm/icons/user.mjs";
import X from "lucide/dist/esm/icons/x.mjs";

export type IconName =
  | "account"
  | "arrow-right"
  | "bell"
  | "chevron-down"
  | "chevrons-up-down"
  | "cpu"
  | "credit-card"
  | "secrets"
  | "dashboard"
  | "folder"
  | "github"
  | "logout"
  | "message"
  | "memory"
  | "more-horizontal"
  | "panel-left"
  | "plus"
  | "server"
  | "settings"
  | "sparkles"
  | "user"
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
        throw new Error(`Unsupported Lucide SVG element: ${tag}`);
    }
  };
}

const iconNodes = {
  account: BadgeCheck,
  "arrow-right": ArrowRight,
  bell: Bell,
  "chevron-down": ChevronDown,
  "chevrons-up-down": ChevronsUpDown,
  cpu: Cpu,
  "credit-card": CreditCard,
  secrets: KeyRound,
  dashboard: LayoutDashboard,
  folder: Folder,
  github: GitBranch,
  logout: LogOut,
  message: MessageSquare,
  memory: MemoryStick,
  "more-horizontal": Ellipsis,
  "panel-left": PanelLeft,
  plus: Plus,
  server: Server,
  settings: Settings,
  sparkles: Sparkles,
  user: User,
  x: X,
} satisfies Record<IconName, IconNode>;

function getIconNodes(name: IconName): IconNode {
  return iconNodes[name];
}
