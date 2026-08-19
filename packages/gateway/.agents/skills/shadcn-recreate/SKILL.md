---
name: shadcn-recreate
description: Recreate shadcn/ui components and blocks as application-owned Remix 3 UI. Use when a Remix app needs shadcn styling, a shadcn-inspired design system, or a shadcn block translated without React/Base UI runtime dependencies. Inspect current official shadcn registry sources, then choose native HTML, remix/ui controls, or Remix primitives according to semantic and behavioral needs.
compatibility: Requires a Remix 3 application using the remix package. Network access is useful for current shadcn registry sources. Intended for application-owned UI, not shadcn API compatibility.
---

# Recreate shadcn designs in Remix 3

Use shadcn as the **current visual and UX reference**, not as runtime architecture. The result must be application-owned, Remix-native UI.

## Non-negotiables

- Inspect the exact current official shadcn block and component sources before coding.
- Preserve semantics, accessibility, and observable behavior before visual fidelity.
- Do not mechanically port React, Base UI, Radix, CVA, Tailwind architecture, or shadcn APIs.
- Do not introduce React compatibility layers, `Slot`, `asChild`, `cloneElement`, `forwardRef`, portals, or fake hooks.
- Prefer server-rendered/native behavior and minimal browser JavaScript.
- Use public `remix/ui` imports rather than importing `@remix-run/ui` directly.

## Workflow

### 1. Inspect the project

1. Confirm Remix 3 rather than Remix v2/React Router.
2. Read the dependency manifest (`deno.json`, `package.json`, or equivalent).
3. Inspect existing UI, tokens, mixins, icons, forms, tests, and module layout.
4. Read relevant installed docs under:

   ```text
   node_modules/remix/src/ui/**/README.md
   ```

5. Inspect the installed implementation when a Remix control's markup or styling affects the decision. README summaries may hide opinionated dimensions, colors, shadows, or structure.

### 2. Inspect official shadcn registry sources

This is mandatory even when the user pasted a block. The block shows composition; referenced registry components define actual spacing, variants, tokens, selectors, and states.

Inspect:

- the requested block
- every low-level component it imports
- registry dependencies such as Label or Separator
- relevant theme tokens

Fetch registry JSON directly when needed:

```text
https://ui.shadcn.com/r/styles/<style>/<component>.json
https://ui.shadcn.com/r/styles/<style>/<block>.json
```

A compatible project package manager may use the shadcn CLI for inspection. In a Deno-only project, fetch registry JSON directly; do not add npm/pnpm files or install shadcn.

### 3. Extract a small specification

Record only:

- **LOOK:** exact tokens, typography, spacing, sizes, borders, radii, shadows, responsive rules, icons, variants, and visual states.
- **UX CONTRACT:** keyboard, focus, dismissal, selection, form participation, disabled/read-only behavior, positioning, and ARIA relationships.
- **PRODUCT API:** what this application actually needs, including whether the result is a reusable design-system primitive or a domain composite.

Do not approximate inspected values with generic “shadcn-like” styling.

### 4. Choose the behavior owner

Use the highest-level abstraction that permits the design:

1. **Native host + application/Remix mixin** — buttons, links, inputs, forms, native select, checkbox/radio, and static visual components.
2. **Composed `remix/ui` control** — behavior-heavy accordion, combobox, menu, select, tabs, popover, and similar controls when markup permits.
3. **`remix/ui/*/primitives`** — only when composed markup cannot produce the required UI.
4. **Small application component** — for reusable design-system or domain composition.
5. **Custom interaction logic** — only when native and Remix behavior cannot satisfy the UX contract.

Let Remix own keyboard, focus, ARIA, dismissal, typeahead, selection, and form behavior whenever available.

A Remix styling mixin is not automatically the right base. If matching shadcn requires overriding most of its dimensions, radius, palette, borders, shadows, focus treatment, and variants, use a native host with application styles instead. Do not stack a nearly fully overridden visual system underneath another one.

### 5. Organize reusable UI deliberately

For OpenOrb:

```text
app/ui/components/   low-level design-system controls and foundations
app/ui/              composite, screen-level, and document UI
```

Low-level examples: button, input, card, field, alert, badge, separator, and theme tokens. Keep each family in its own module and expose a deliberate barrel when useful.

Composite examples: authentication UI, application shell, document layout, and project/session-specific views.

Rules:

- Keep generic tokens and variants out of screen-specific composites.
- Make composites consume low-level modules rather than duplicate styles.
- Preserve native element props and semantics.
- Keep domain behavior out of low-level visual components.
- Do not reproduce shadcn's compound API unless the product benefits from it.

### 6. Translate styling and state

- Use the project's styling system; do not add Tailwind solely because shadcn uses it.
- Translate verified values, not Tailwind syntax.
- Bind state styles to the actual native/Remix attributes, not blindly copied Base UI selectors.
- Include relevant focus, hover, active, disabled, invalid, responsive, `:has(...)`, selection, file-input, and dark-mode behavior.
- Keep `data-slot` only when useful for local styling or tests.
- Static cards, alerts, labels, tables, and typography should remain server-rendered.
- Delete React hook logic when native HTML or Remix owns the state.
- If custom Remix state is necessary, use setup scope, `handle.props`, `handle.update()`, and current Remix lifecycle APIs.

## Validation

Test the observable contract relevant to each control:

- activation and pointer behavior
- keyboard navigation and Escape
- focus entry, containment, and return
- disabled and invalid behavior
- selected/checked/expanded state
- form value participation
- accessible role, name, and state
- dismissal, scrolling, and positioning

Run formatter, lint, typecheck, and relevant tests. Check for accidental upstream runtime dependencies:

```sh
grep -R -nE "from ['\"]react|from ['\"]react-dom|@base-ui/react|radix-ui|class-variance-authority" app
```

## Completion report

Report:

- official shadcn block/components inspected
- abstractions chosen and behavior owner
- low-level and composite modules changed
- visual rules borrowed and intentional departures
- dependencies changed
- tests/typecheck performed
- known limitations

Do not claim shadcn compatibility unless explicitly requested.
