# Recipe: preload a file tree on the server

Preload markup on the server and hydrate it in the browser with the same
options:

```ts
import { preloadFileTree, serializeFileTreeSsrPayload } from '@pierre/trees/ssr';

const options = {
  id: 'project-files',
  paths: ['README.md', 'src/', 'src/index.ts'],
  initialExpansion: 'open' as const,
  initialVisibleRowCount: 8,
};

const html = serializeFileTreeSsrPayload(preloadFileTree(options));
```

The markup is a `<file-tree-container id="project-files">` host with a
declarative shadow root. In the browser, build the model with identical options
and hydrate that host:

```ts
import { FileTree } from '@pierre/trees';

const host = document.getElementById('project-files');
if (host == null) throw new Error('Missing file tree host');

new FileTree(options).hydrate({ fileTreeContainer: host });
```

Pass `dom` as the second argument to `serializeFileTreeSsrPayload` when a DOM
API inserts the complete markup string instead of the HTML parser.
