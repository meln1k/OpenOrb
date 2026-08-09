# Component Strategy

Use this file as a design-to-Remix decision guide.

The default question is:

> What is the highest-level Remix/native abstraction that can produce the desired design without compromising product requirements?

## Button

Prefer native semantic hosts.

Use:
- `<button>` for actions
- `<a>` for navigation

Share appearance as a mixin/style helper when useful.

Do not create a polymorphic `asChild` compatibility layer.

A "Button component" is justified only when it meaningfully simplifies product code.

## Checkbox and Radio

Prefer native inputs.

Apply Remix/app style mixins to the native host.

Benefits:
- browser keyboard behavior
- native checked/disabled semantics
- direct `FormData` participation
- minimal JS

Use shadcn for visual inspiration only:
- dimensions
- border
- indicator
- focus ring
- disabled styling

## Input / Textarea / Label

Prefer native elements plus shared style mixins.

A wrapper component is optional, not automatic.

Build a higher-level field abstraction only when the app needs coordinated label, description, error, or layout behavior.

## Card / Alert / Badge / Table / Breadcrumb / Skeleton / Typography

Usually plain server-rendered markup plus application styling.

Do not create browser-interactive components.

Do not preserve shadcn file/export structure unless useful.

## Accordion

Try in this order:

1. composed `remix/ui/accordion`
2. `remix/ui/accordion/primitives` if custom host markup is actually required

Do not own open state manually if Remix already owns it.

Use shadcn for:
- trigger layout
- border treatment
- icon/chevron
- spacing
- open/close animation

A product API such as:

```tsx
<FaqAccordion items={faqs} />
```

may be preferable to a generic compound API.

## Select

Try in this order:

1. native `<select>` if sufficient
2. composed `remix/ui/select`
3. `remix/ui/select/primitives`

Let Remix own listbox/popover/form semantics.

Use shadcn for:
- trigger appearance
- popup dimensions
- item density
- selected indicator
- animation
- group/label styling

Do not reproduce every shadcn subcomponent unless the application benefits from it.

## Combobox

Prefer composed `remix/ui/combobox`.

Use primitives only for required custom markup.

Do not manually recreate:
- filtering coordination
- active option state
- keyboard navigation
- focus behavior

Use shadcn as a visual reference for input, list surface, empty state, item layout, and selected indication.

## Menu / Dropdown Menu

Prefer composed `remix/ui/menu`.

Use primitives only if product markup demands them.

Reuse Remix for:
- roving focus
- keyboard behavior
- selection semantics
- dismissal
- submenus if supported

Use shadcn for:
- item spacing
- destructive styles
- separators
- shortcuts
- nested indicators
- menu surface

## Tabs

Prefer composed `remix/ui/tabs`.

Use shadcn for:
- tablist surface
- active styling
- spacing
- content layout

Use primitives only when markup materially differs.

## Toggle

Prefer native/Remix toggle behavior according to installed docs.

Do not create custom pressed-state logic if Remix already supplies it.

## Popover

Prefer `remix/ui/popover` for non-modal anchored floating UI.

Use shadcn for surface and animation.

Do not treat Popover as Dialog.

## Dialog / Sheet / Alert Dialog

Inspect current Remix support first.

Then consider native `<dialog>` if it satisfies the full UX contract.

A modal must correctly handle applicable:
- labeling
- focus entry
- focus containment
- Escape
- focus restoration
- background interaction/inertness
- scrolling

Do not preserve shadcn's compound Dialog API unless it improves the application.

Product-specific APIs are often better:

```tsx
<DeleteProjectDialog project={project} />
```

## Tooltip / Hover Card

Inspect current Remix support.

Prefer browser/native behavior when it meets accessibility requirements.

Do not implement hover-only behavior that excludes keyboard users.

## Switch / Slider / Navigation Menu / Context Menu

Inspect installed Remix UI first.

If no matching control exists:
1. determine whether native HTML solves it
2. determine whether an existing primitive composes safely
3. otherwise stop before rebuilding a complex accessibility-sensitive widget casually

## Styling-only "components"

Some shadcn components should become style helpers, not components.

Examples:

```tsx
const buttonStyles = css({...})
const inputStyles = css({...})
const surfaceStyles = css({...})
```

Use these directly on host elements through project/Remix composition conventions.

This is often more Remix-native than a wrapper component.
