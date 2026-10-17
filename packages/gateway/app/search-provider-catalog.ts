/** Web search providers with Workspace API keys, in the order web_search tries them. */
export const SEARCH_PROVIDER_IDS = ["exa", "brave", "tavily"] as const;

export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

export const SEARCH_PROVIDER_NAMES = {
  exa: "Exa",
  brave: "Brave Search",
  tavily: "Tavily",
} satisfies Record<SearchProviderId, string>;
