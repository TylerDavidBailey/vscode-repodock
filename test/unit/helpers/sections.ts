import { ExpansionStore } from '../../../src/ext/expansion';
import { PinStore } from '../../../src/ext/pins';
import { RecencyStore } from '../../../src/ext/recency';
import { RepoModel } from '../../../src/ext/repoModel';
import { RepoTreeProvider, type Section, type TreeNode } from '../../../src/ext/treeProvider';
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

/**
 * The rows directly under one section heading, from a fresh render. Empty when the
 * section is not shown, which is how the view treats a section with nothing in it.
 */
export function sectionRows(provider: RepoTreeProvider, section: Section): TreeNode[] {
  const heading = provider
    .getChildren()
    .find((node) => node.kind === 'section' && node.section === section);
  return heading ? provider.getChildren(heading) : [];
}

/** The text of a rendered row. `TreeItem.label` can also be an object carrying highlights. */
export function labelOf(provider: RepoTreeProvider, node: TreeNode): string {
  const { label } = provider.getTreeItem(node);
  return typeof label === 'string' ? label : (label?.label ?? '');
}

/** Rows as indented labels, the way the view draws them. */
export function outline(provider: RepoTreeProvider, nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    '  '.repeat(depth) + labelOf(provider, node),
    ...outline(provider, provider.getChildren(node), depth + 1),
  ]);
}
