import { ExpansionStore } from '../../../src/ext/expansion';
import { PinStore } from '../../../src/ext/pins';
import { RecencyStore } from '../../../src/ext/recency';
import { RepoModel } from '../../../src/ext/repoModel';
import { RepoTreeProvider, type TreeNode } from '../../../src/ext/treeProvider';
import { fakeMemento } from './memento';

/** A model with the view provider and the stores it reads, wired the way `activate` wires them. */
export interface Rendered {
  model: RepoModel;
  recency: RecencyStore;
  pins: PinStore;
  expansion: ExpansionStore;
  provider: RepoTreeProvider;
}

/**
 * Builds the view provider over a model with fresh in-memory stores, so no test can observe
 * another's pins or recency. Nothing is scanned: seed the mocked scanner, then
 * `await model.refresh()`.
 */
export function createProvider(model: RepoModel = new RepoModel()): Rendered {
  const recency = new RecencyStore(fakeMemento());
  const pins = new PinStore(fakeMemento());
  const expansion = new ExpansionStore(fakeMemento());
  return {
    model,
    recency,
    pins,
    expansion,
    provider: new RepoTreeProvider(model, recency, pins, expansion),
  };
}

/** The text of a rendered row. `TreeItem.label` can also be an object carrying highlights. */
export function labelOf(provider: RepoTreeProvider, node: TreeNode): string {
  const { label } = provider.getTreeItem(node);
  return typeof label === 'string' ? label : (label?.label ?? '');
}

/**
 * Rows as indented labels, the way the view draws them, from a fresh render unless `nodes`
 * is given. The gap row reads as an empty string.
 */
export function outline(
  provider: RepoTreeProvider,
  nodes: TreeNode[] = provider.getChildren(),
  depth = 0,
): string[] {
  return nodes.flatMap((node) => [
    '  '.repeat(depth) + labelOf(provider, node),
    ...outline(provider, provider.getChildren(node), depth + 1),
  ]);
}
