-- Sessions this Session's agent may reach besides its parent (ADR 0010): its children, which it may
-- read and message, and Sessions whose URL the user pasted into a prompt, which it may only read.
CREATE TABLE openorb_thread_access (
  session_id TEXT PRIMARY KEY,
  relation TEXT NOT NULL CHECK (relation IN ('child', 'referenced'))
);
