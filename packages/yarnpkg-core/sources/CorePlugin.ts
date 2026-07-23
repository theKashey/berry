import {Resolution}               from '@yarnpkg/parsers';

import {MessageName}              from './MessageName';
import {Plugin}                   from './Plugin';
import {Project}                  from './Project';
import {Resolver, ResolveOptions} from './Resolver';
import {Workspace}                from './Workspace';
import * as structUtils           from './structUtils';
import {Descriptor, Locator}      from './types';

// The `resolutions` field of the top-level workspace is applied to every single
// dependency of every single package during resolution (see `reduceDependency`
// below). A naive scan over the whole `resolutions` array per dependency is
// O(dependencies × resolutions), which becomes a major bottleneck on large
// monorepos (e.g. 160k+ dependencies × 1000+ resolutions ≈ hundreds of millions
// of iterations). Since the very first filter is an exact match on
// `pattern.descriptor.fullName`, we can index the resolutions by that key and
// only consider the (usually zero or one) patterns that could possibly match,
// turning the hot path into an O(dependencies) map lookup.
//
// The index is memoized against the identity of the manifest `resolutions`
// array so it's rebuilt only if the resolutions change. Patterns are stored in
// their original array order per key so that the "first matching pattern wins"
// semantics of the original loop are preserved exactly.
type ResolutionEntry = {pattern: Resolution, reference: string};

const resolutionsIndexCache = new WeakMap<Array<ResolutionEntry>, Map<string, Array<ResolutionEntry>>>();

const getResolutionsIndex = (resolutions: Array<ResolutionEntry>): Map<string, Array<ResolutionEntry>> => {
  let index = resolutionsIndexCache.get(resolutions);
  if (typeof index !== `undefined`)
    return index;

  index = new Map();
  for (const entry of resolutions) {
    let bucket = index.get(entry.pattern.descriptor.fullName);
    if (typeof bucket === `undefined`)
      index.set(entry.pattern.descriptor.fullName, bucket = []);

    bucket.push(entry);
  }

  resolutionsIndexCache.set(resolutions, index);
  return index;
};

export const CorePlugin: Plugin = {
  hooks: {
    reduceDependency: (dependency: Descriptor, project: Project, locator: Locator, initialDependency: Descriptor, {resolver, resolveOptions}: {resolver: Resolver, resolveOptions: ResolveOptions}) => {
      const resolutions = project.topLevelWorkspace.manifest.resolutions;

      // Fast path: the first filter in the original loop is an exact match on
      // `pattern.descriptor.fullName === stringifyIdent(dependency)`, so only
      // patterns sharing this key can possibly match. We look them up directly
      // instead of scanning the entire `resolutions` array for every dependency.
      const candidates = getResolutionsIndex(resolutions).get(structUtils.stringifyIdent(dependency));
      if (typeof candidates === `undefined`)
        return dependency;

      for (const {pattern, reference} of candidates) {
        if (pattern.from) {
          if (pattern.from.fullName !== structUtils.stringifyIdent(locator))
            continue;

          const normalizedFrom = project.configuration.normalizeLocator(
            structUtils.makeLocator(
              structUtils.parseIdent(pattern.from.fullName),
              pattern.from.description ?? locator.reference,
            ),
          );

          if (normalizedFrom.locatorHash !== locator.locatorHash) {
            continue;
          }
        }

        /* All `resolutions` field entries have a descriptor*/ {
          // `pattern.descriptor.fullName === stringifyIdent(dependency)` holds by
          // construction of the index, so we only need the description check.
          const normalizedDescriptor = project.configuration.normalizeDependency(
            structUtils.makeDescriptor(
              structUtils.parseLocator(pattern.descriptor.fullName),
              pattern.descriptor.description ?? dependency.range,
            ),
          );

          if (normalizedDescriptor.descriptorHash !== dependency.descriptorHash) {
            continue;
          }
        }

        const alias = resolver.bindDescriptor(
          project.configuration.normalizeDependency(structUtils.makeDescriptor(dependency, reference)),
          project.topLevelWorkspace.anchoredLocator,
          resolveOptions,
        );

        return alias;
      }

      return dependency;
    },

    validateProject: async (project: Project, report: {
      reportWarning: (name: MessageName, text: string) => void;
      reportError: (name: MessageName, text: string) => void;
    }) => {
      for (const workspace of project.workspaces) {
        const workspaceName = structUtils.prettyWorkspace(project.configuration, workspace);

        await project.configuration.triggerHook(hooks => {
          return hooks.validateWorkspace;
        }, workspace, {
          reportWarning: (name: MessageName, text: string) => report.reportWarning(name, `${workspaceName}: ${text}`),
          reportError: (name: MessageName, text: string) => report.reportError(name, `${workspaceName}: ${text}`),
        });
      }
    },

    validateWorkspace: async (workspace: Workspace, report: {
      reportWarning: (name: MessageName, text: string) => void;
      reportError: (name: MessageName, text: string) => void;
    }) => {
      // Validate manifest
      const {manifest} = workspace;

      if (manifest.resolutions.length && workspace.cwd !== workspace.project.cwd)
        manifest.errors.push(new Error(`Resolutions field will be ignored`));

      for (const manifestError of manifest.errors) {
        report.reportWarning(MessageName.INVALID_MANIFEST, manifestError.message);
      }
    },
  },
};
