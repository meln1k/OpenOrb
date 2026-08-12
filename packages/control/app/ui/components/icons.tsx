import type { Handle } from "remix/ui";

export type IconName =
  | "account"
  | "bell"
  | "chevron-down"
  | "chevrons-up-down"
  | "credit-card"
  | "secrets"
  | "dashboard"
  | "folder"
  | "logout"
  | "message"
  | "more-horizontal"
  | "panel-left"
  | "plus"
  | "server"
  | "settings"
  | "sparkles"
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
        <IconPaths name={handle.props.name} />
      </svg>
    );
  };
}

function IconPaths(handle: Handle<{ name: IconName }>) {
  return () => {
    switch (handle.props.name) {
      case "account":
        return (
          <>
            <path d="M12 3 14.2 5.2 17.3 4.7 18.1 7.8 21 9.2 19.6 12 20.3 15.1 17.2 15.9 15.8 18.8 13 17.4 9.9 18.1 9.1 15 6.2 13.6 7.6 10.8 6.9 7.7 10 6.9Z" />
            <path d="m9.5 12 1.7 1.7 3.5-3.5" />
          </>
        );
      case "bell":
        return (
          <>
            <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          </>
        );
      case "chevron-down":
        return <path d="m6 9 6 6 6-6" />;
      case "chevrons-up-down":
        return (
          <>
            <path d="m7 15 5 5 5-5" />
            <path d="m7 9 5-5 5 5" />
          </>
        );
      case "credit-card":
        return (
          <>
            <rect width="20" height="14" x="2" y="5" rx="2" />
            <path d="M2 10h20" />
          </>
        );
      case "secrets":
        return (
          <>
            <circle cx="7.5" cy="15.5" r="5.5" />
            <path d="m21 2-9.6 9.6M15 7l2 2M18 4l2 2" />
          </>
        );
      case "dashboard":
        return (
          <>
            <rect width="7" height="9" x="3" y="3" rx="1" />
            <rect width="7" height="5" x="14" y="3" rx="1" />
            <rect width="7" height="9" x="14" y="12" rx="1" />
            <rect width="7" height="5" x="3" y="16" rx="1" />
          </>
        );
      case "folder":
        return (
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        );
      case "logout":
        return (
          <>
            <path d="M10 17l5-5-5-5" />
            <path d="M15 12H3" />
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          </>
        );
      case "message":
        return <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />;
      case "more-horizontal":
        return (
          <>
            <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
            <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
          </>
        );
      case "panel-left":
        return (
          <>
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18" />
          </>
        );
      case "plus":
        return (
          <>
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </>
        );
      case "server":
        return (
          <>
            <rect width="20" height="8" x="2" y="2" rx="2" />
            <rect width="20" height="8" x="2" y="14" rx="2" />
            <path d="M6 6h.01M6 18h.01" />
          </>
        );
      case "settings":
        return (
          <>
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
            <circle cx="12" cy="12" r="3" />
          </>
        );
      case "sparkles":
        return (
          <>
            <path d="m12 3-1.7 4.3L6 9l4.3 1.7L12 15l1.7-4.3L18 9l-4.3-1.7Z" />
            <path d="m5 16-.7 1.8-1.8.7 1.8.7L5 21l.7-1.8 1.8-.7-1.8-.7Z" />
            <path d="m19 15-.7 1.8-1.8.7 1.8.7L19 20l.7-1.8 1.8-.7-1.8-.7Z" />
          </>
        );
      case "x":
        return (
          <>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </>
        );
    }
  };
}
