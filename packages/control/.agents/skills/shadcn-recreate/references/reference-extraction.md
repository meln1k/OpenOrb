# Reference Extraction

When inspecting shadcn/Base UI source, do not translate its architecture.

Produce a tiny internal specification with only three sections.

## LOOK

Example:

```text
Trigger:
- 36px high
- horizontal padding 12px
- rounded medium
- subtle border
- muted placeholder
- focus ring
- disabled opacity

Popup:
- min width = trigger
- rounded medium
- border + shadow
- 4px inner padding
- short scale/fade animation

Item:
- 32px row
- horizontal padding 8px
- selected check at left
- destructive variant
```

Capture design values, not framework syntax.

## UX CONTRACT

Example:

```text
- trigger opens popup
- current value shown in trigger
- arrows move active option
- Enter chooses
- Escape closes
- selected item indicated
- disabled item cannot activate
- chosen value submitted with form
- focus behavior follows accessible listbox conventions
```

Do not copy Base UI implementation details into this section.

## PRODUCT API

Example:

```text
Need:
- one EnvironmentSelect
- controlled value
- array of environment records
- no grouped options
- no custom item children
- form name required
```

This often reveals that the correct application component is much smaller than shadcn.

## Then map ownership

For each UX requirement, identify the owner:

```text
browser
native host
composed remix/ui
remix/ui primitive
application state
CSS
```

Example:

```text
Select:
open/close        -> remix/ui/select
keyboard nav      -> remix/ui/select
form value        -> remix/ui/select hidden/native form behavior
popup appearance  -> app CSS
trigger icon      -> app markup
domain options    -> application
```

Avoid duplicated ownership.

## Styling translation

Do not automatically keep Tailwind.

Translate upstream classes into the app's established styling language.

Retain Tailwind only when the project already uses it and keeping the classes is the clearest solution.

For stateful styles:
1. identify semantic state
2. inspect Remix/native output
3. bind style to actual state attributes/selectors
4. delete obsolete Base UI selectors

## React code classification

When encountering React/Base UI code, classify what it was accomplishing:

```text
hook state       -> maybe delete; prefer primitive ownership
effect           -> event consequence / DOM lifecycle / browser API?
context          -> primitive context / application structure?
forwardRef       -> likely unnecessary
Portal           -> determine actual product requirement
render/asChild   -> choose real semantic host or Remix primitive
```

Never create a mechanical React-to-Remix mapping table.

## Final check

Before implementing, you should be able to summarize the design without mentioning:
- React
- Base UI
- shadcn subcomponent names

If you cannot, you are still thinking in upstream architecture rather than product requirements.
