---
name: shadcn-recreate
description: Recreate shadcn/ui designs as application-owned Remix 3 UI. Use shadcn/Base UI only to understand visual design and interaction expectations, then implement with the highest-level Remix-native abstraction that permits the desired design: native elements plus mixins first, composed remix/ui controls second, headless Remix primitives third, and custom application logic only when necessary.
compatibility: Requires a Remix 3 application using the remix package. Network access is useful for inspecting current shadcn/Base UI reference implementations. Intended for application-owned UI, not shadcn API compatibility.
---

# Recreate shadcn designs using Remix-native UI

Do **not** port shadcn.

Use shadcn as a design catalog and behavioral reference, then construct the desired interface from Remix's native UI vocabulary.

The resulting UI belongs to the application.

## Core rule

> Use the highest-level Remix abstraction that permits the desired design.

Apply this order:

1. native HTML element + Remix/app styling mixin
2. composed `remix/ui` control
3. `remix/ui/*/primitives`
4. small application-specific Remix component
5. custom interaction logic only when required

Do not drop to primitives merely because upstream shadcn uses a compound component API.

Do not create a reusable component merely because shadcn calls something a component.

## Priorities

Apply these in order:

1. correct semantics, behavior, and accessibility
2. idiomatic Remix architecture
3. minimal browser JavaScript
4. visual fidelity to the desired shadcn design
5. reuse of application tokens, styles, and utilities
6. small application-focused APIs
7. minimal dependencies
8. shadcn implementation/API compatibility — **not a goal**

## Mental model

Use:

```text
shadcn
  ↓
LOOK + UX CONTRACT
  ↓
inspect Remix/native capabilities
  ↓
choose highest-level suitable abstraction
  ↓
apply app styling
  ↓
application-owned UI
```

Never optimize for:

```text
shadcn source
  ↓
React/Base UI translation
  ↓
same component tree/API
```

The upstream source is disposable reference material.

## Inspect the project first

Before implementing:

1. Confirm this is Remix 3, not Remix v2/React Router.
2. Read `package.json`.
3. Inspect existing UI patterns under locations such as:
   - `app/ui/`
   - `app/components/`
4. Identify:
   - styling system
   - design tokens
   - mixin conventions
   - class/variant helpers
   - icon conventions
   - form conventions
   - test utilities
5. Read the installed Remix UI docs relevant to the task:
   ```text
   node_modules/remix/src/ui/**/README.md
   ```
6. Prefer the installed package docs over static assumptions because Remix 3 evolves quickly.

When the shadcn design itself needs inspection:

```sh
pnpm dlx shadcn@latest docs <component> -b base --json
pnpm dlx shadcn@latest add <component> --dry-run
```

Use the project's package manager.

Do not install the React/Base UI implementation into the app unless the user explicitly asks to use it as temporary source material.

## Extract only three things from shadcn

Before coding, reduce the reference implementation to these three buckets.

### 1. LOOK

Record only design intent:

- colors and tokens
- typography
- spacing
- sizing
- borders
- radii
- shadows
- focus treatment
- hover/active/disabled states
- dark mode
- responsive behavior
- animations/transitions
- icons
- variants

Do not treat Tailwind syntax itself as sacred.

### 2. UX CONTRACT

Write the observable behavior in plain language.

Examples:

```text
- click trigger to open
- Escape closes
- focus returns to trigger
- arrow keys navigate
- selected item is indicated
- disabled items cannot activate
- chosen value participates in FormData
```

This contract matters more than Base UI's internal implementation.

Include relevant:
- keyboard behavior
- focus behavior
- controlled/uncontrolled state
- form participation
- outside-click behavior
- modal/inert behavior
- typeahead
- positioning
- disabled/read-only behavior
- ARIA relationships

### 3. PRODUCT API

Decide what the application actually needs.

Ask:
- Is this generic UI or domain-specific?
- Does this need a component at all?
- Would a style mixin be enough?
- Does the caller need controlled state?
- Would data props be simpler than child composition?
- Which variants are actually used?
- Can native HTML eliminate an abstraction?

Do not inherit an API from shadcn by default.

## Remix UI decision tree

Follow this decision tree for every requested design.

### Level 1 — native host + mixin

First ask whether native HTML already owns the semantics and behavior.

Prefer native:
- `button`
- `a`
- `input`
- `textarea`
- checkbox/radio inputs
- native forms
- `select` when a custom listbox is unnecessary
- `details`/`summary` when appropriate
- browser dialog/popover APIs when they satisfy the complete UX contract

Then express appearance using the project's styling system, including Remix mixins where appropriate.

For example, a shadcn-style checkbox may be best represented as:

```tsx
<input
  type="checkbox"
  name="notifications"
  mix={[checkbox(), checkboxStyles]}
/>
```

rather than a new `<Checkbox>` abstraction.

This preserves browser keyboard and form semantics.

### Level 2 — composed `remix/ui` control

If native HTML is insufficient, look for a composed first-party Remix control.

Typical candidates:
- accordion
- combobox
- menu
- select
- tabs
- other current `remix/ui` controls

Prefer the composed control when its markup is compatible with the desired design.

Let Remix own:
- state transitions
- ARIA relationships
- keyboard interactions
- focus coordination
- form integration
- hidden inputs
- dismissal behavior

Do not manually re-create state that the Remix control already owns.

### Level 3 — Remix headless primitives

Drop down to `remix/ui/*/primitives` only when the desired product UI genuinely requires different markup or composition.

Use primitives to attach Remix behavior to application-owned host elements.

Prefer:

```tsx
<button mix={[triggerStyles, accordion.trigger()]}>
```

over rebuilding accordion behavior.

Primitives are for markup control, not merely different colors, spacing, or radii.

### Level 4 — small application abstraction

Create an application component only when it improves the calling code or coordinates product-specific behavior.

Prefer domain APIs such as:

```tsx
<EnvironmentSelect
  value={environment}
  options={environments}
  onChange={setEnvironment}
/>
```

over reproducing a generic shadcn compound API.

A screen-specific component is valid if it is the cleanest abstraction.

### Level 5 — custom interaction logic

Only write custom state/focus/keyboard behavior when native HTML and Remix UI cannot satisfy the UX contract.

Before doing so, enumerate every semantic obligation and test it.

Stop rather than guessing if correctness cannot be established.

## Styling policy

The **appearance** is valuable; the upstream styling representation is not.

### Prefer the application's styling system

If the app already uses Tailwind and preserving the shadcn classes is simplest, keep them.

If the app uses Remix `css(...)`, CSS modules, design-token mixins, or another established system, translate the design into that system.

Do not introduce Tailwind merely because shadcn used Tailwind.

### Convert values, not syntax

Example upstream intent:

```text
inline-flex
height 36px
horizontal padding 16px
medium radius
14px medium text
focus ring
disabled opacity 50%
```

Express that intent idiomatically in the application.

### State selectors

Never copy Base UI state selectors blindly.

For every state-dependent style:

1. identify the visual state
2. determine who owns that state in the Remix/native implementation
3. inspect the actual emitted state/ARIA/native attribute
4. write styles against that source

Example:

```text
Base UI source: data-open / data-panel-open
Remix implementation: data-state="open"
```

Preserve the open-state visual effect, not the upstream attribute.

### `data-slot`

Keep only if useful for project styling or tests.

It has no compatibility value on its own.

## Server-rendering and client-JavaScript rule

Do not make UI client-interactive merely because the shadcn source was a React client component.

Start from server-rendered/native markup.

Only add browser interaction where the UX contract requires:
- events
- browser APIs
- interactive Remix primitives
- client-side state coordination

Static/mostly visual designs such as cards, alerts, badges, labels, tables, breadcrumbs, and typography should generally not require client runtime.

Prefer native form submission and browser semantics where they satisfy the product requirement.

## Remix component state

Do not convert React hooks mechanically.

Usually the correct transformation is:

```text
React/Base UI state
  ↓
delete it
  ↓
let native HTML or remix/ui own it
```

Only use application-owned Remix component state when the app actually needs state beyond what the selected primitive provides.

When custom component state is required, follow the installed Remix component-model documentation:
- state lives in setup scope
- current props come from `handle.props`
- mutations requiring rerender call `handle.update()`
- imperative DOM work does not run during render
- use current Remix event/ref/lifecycle APIs rather than React hook emulation

## Do not emulate React or Base UI

Never introduce:
- React runtime dependencies
- compatibility shims
- fake hooks
- `forwardRef` adapters
- generic `cloneElement`
- generic `Slot`
- `asChild` emulation
- Base UI runtime adapters
- React portal abstractions

If an upstream abstraction disappears, that is usually desirable.

## Composition

Prefer actual semantic hosts over polymorphic wrappers.

For example, instead of preserving a generic shadcn Button with `asChild`:

```tsx
<Button>Save</Button>
<LinkButton href="/settings">Settings</LinkButton>
```

or simply:

```tsx
<button mix={buttonStyles}>Save</button>
<a href="/settings" mix={buttonStyles}>Settings</a>
```

Choose the form that best fits current project conventions.

## Component guidance

Read [references/component-strategy.md](references/component-strategy.md) for concrete starting points.

## Reference extraction

Read [references/reference-extraction.md](references/reference-extraction.md) when inspecting shadcn/Base UI source.

## Acceptance criteria

For each interactive control, test the relevant observable contract:

- activation
- keyboard navigation
- Escape
- outside dismissal
- focus entry
- focus return
- modal focus containment
- background inertness
- disabled behavior
- selected/checked/expanded state
- form value
- accessible role/name/state
- typeahead
- orientation
- pointer interaction
- scrolling/positioning

Visual similarity alone does not complete the task.

## Tests

Prefer focused behavior tests over snapshots.

Examples:
- accordion opens and keyboard navigation works
- native checkbox participates correctly in `FormData`
- select submits its value
- menu arrows between items and dismisses correctly
- modal returns focus after close

Run the project's:
- typecheck
- relevant tests
- formatter/linter when present

Search changed files for accidental React/Base UI dependencies:

```sh
grep -R -nE "from ['\"]react|from ['\"]react-dom|@base-ui/react" app
```

## Updates from shadcn

Do not automatically sync application-owned UI with upstream.

When asked to refresh a design:

1. inspect the current shadcn design
2. extract only meaningful visual/UX changes
3. apply them to the existing Remix-native implementation
4. preserve good local architecture
5. ignore React/Base UI-only refactors

## Completion report

Report:
- UI/design added or changed
- which abstraction level was chosen
  - native + mixin
  - composed Remix control
  - Remix primitive
  - local application component
- Remix/native behavior used
- visual ideas borrowed from shadcn
- intentional departures from shadcn
- dependencies changed
- tests/typecheck performed
- known limitations

Do not call the result shadcn-compatible unless compatibility was explicitly requested.
