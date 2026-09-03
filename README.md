# Nasab

A guided data-entry app for recording a patrilineal family tree. Instead of
asking you to click around a diagram, it walks you through the tree one father
at a time and tells you exactly whose children it wants next.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## How entry works

**Phase 1 — children.** You start with the root ancestor, who becomes `M001`.
For each man the app asks for his children oldest to youngest. Sons are assigned
sequential male IDs (`M002`, `M003`, …) and daughters sequential female IDs
(`F001`, `F002`, …), in the order you enter them. Submitting an empty field
means "this man has no more children."

The app then moves depth-first through the male line: to the man's first son, on
to *that* son's first son, and so on. When a man has no sons, it backtracks to
the nearest unvisited younger brother up the chain. The sidebar highlights whose
turn it is, and the breadcrumb above the form shows the line of descent from the
root.

**Phase 2 — wives.** Once every man has been asked about his children, the app
revisits each man in the same depth-first order and collects his wives. An empty
field moves to the next man.

**Phase 3 — review.** The finished tree can be downloaded as JSON or as an
indented text outline.

Throughout, <kbd>Enter</kbd> submits and <kbd>Enter</kbd> on an empty field
advances. Only the most recently added child can be removed, which keeps the ID
sequence free of gaps.

## Data shape

```ts
interface Person {
  id: string // "M001", "F001"
  name: string
  gender: 'M' | 'F'
  children: Person[] // in birth order, sons and daughters interleaved
  wives: string[]
}
```

## Layout

| Path                          | Purpose                                                |
| ----------------------------- | ------------------------------------------------------ |
| `src/types.ts`                | `Person` and the traversal state machine's shape        |
| `src/treeUtils.ts`            | Pure tree helpers: lookup, DFS order, export formatting |
| `src/useTreeBuilder.ts`       | The state machine driving both phases                   |
| `src/components/EntryForm.tsx` | The name field, gender toggle, and submit behaviour     |
| `src/components/TreeView.tsx` | The recursive sidebar tree                              |
| `src/App.tsx`                 | Phase routing and screen layout                         |

## Scripts

| Command           | Effect                       |
| ----------------- | ---------------------------- |
| `npm run dev`     | Start the dev server         |
| `npm run build`   | Typecheck and build to `dist` |
| `npm run lint`    | Run oxlint                   |
| `npm run preview` | Serve the production build   |
