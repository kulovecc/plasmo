import { ALL_EDGE_TYPES, NodeId } from "@parcel/graph"
import type {
  BundleGroup,
  Bundle as LegacyBundle,
  MutableBundleGraph
} from "@parcel/types"
import invariant from "assert"
import nullthrows from "nullthrows"

import type { Bundle, IdealGraph } from "./types"

export function decorateLegacyGraph(
  idealGraph: IdealGraph,
  bundleGraph: MutableBundleGraph
): void {
  const idealBundleToLegacyBundle: Map<Bundle, LegacyBundle> = new Map()
  const {
    bundleGraph: idealBundleGraph,
    dependencyBundleGraph,
    bundleGroupBundleIds
  } = idealGraph
  const entryBundleToBundleGroup: Map<NodeId, BundleGroup> = new Map()

  // Step Create Bundles: Create bundle groups, bundles, and shared bundles and add assets to them
  for (const [bundleNodeId, idealBundle] of idealBundleGraph.nodes) {
    if (idealBundle === "root") continue
    const entryAsset = idealBundle.mainEntryAsset
    let bundleGroup
    let bundle

    if (bundleGroupBundleIds.has(bundleNodeId)) {
      const dependencies = dependencyBundleGraph
        .getNodeIdsConnectedTo(
          dependencyBundleGraph.getNodeIdByContentKey(String(bundleNodeId)),
          ALL_EDGE_TYPES
        )
        .map((nodeId) => {
          const dependency = nullthrows(dependencyBundleGraph.getNode(nodeId))
          invariant(dependency.type === "dependency")
          return dependency.value
        })

      for (const dependency of dependencies) {
        bundleGroup = bundleGraph.createBundleGroup(
          dependency,
          idealBundle.target
        )
      }

      invariant(bundleGroup)
      entryBundleToBundleGroup.set(bundleNodeId, bundleGroup)
      bundle = nullthrows(
        bundleGraph.createBundle({
          entryAsset: nullthrows(entryAsset),
          needsStableName: idealBundle.needsStableName,
          bundleBehavior: idealBundle.bundleBehavior,
          target: idealBundle.target
        })
      )
      bundleGraph.addBundleToBundleGroup(bundle, bundleGroup)
    } else if (idealBundle.sourceBundles.size > 0) {
      bundle = nullthrows(
        bundleGraph.createBundle({
          uniqueKey:
            [...idealBundle.assets].map((asset) => asset.id).join(",") +
            [...idealBundle.sourceBundles].join(","),
          needsStableName: idealBundle.needsStableName,
          bundleBehavior: idealBundle.bundleBehavior,
          type: idealBundle.type,
          target: idealBundle.target,
          env: idealBundle.env
        })
      )
    } else if (idealBundle.uniqueKey != null) {
      bundle = nullthrows(
        bundleGraph.createBundle({
          uniqueKey: idealBundle.uniqueKey,
          needsStableName: idealBundle.needsStableName,
          bundleBehavior: idealBundle.bundleBehavior,
          type: idealBundle.type,
          target: idealBundle.target,
          env: idealBundle.env
        })
      )
    } else {
      invariant(entryAsset != null)
      bundle = nullthrows(
        bundleGraph.createBundle({
          entryAsset,
          needsStableName: idealBundle.needsStableName,
          bundleBehavior: idealBundle.bundleBehavior,
          target: idealBundle.target
        })
      )
    }

    idealBundleToLegacyBundle.set(idealBundle, bundle)

    for (const asset of idealBundle.assets) {
      bundleGraph.addAssetToBundle(asset, bundle)
    }
  }

  // Step Internalization: Internalize dependencies for bundles
  for (const [, idealBundle] of idealBundleGraph.nodes) {
    if (idealBundle === "root") continue
    const bundle = nullthrows(idealBundleToLegacyBundle.get(idealBundle))

    for (const internalized of idealBundle.internalizedAssetIds) {
      const incomingDeps = bundleGraph.getIncomingDependencies(
        bundleGraph.getAssetById(internalized)
      )

      for (const incomingDep of incomingDeps) {
        if (
          incomingDep.priority === "lazy" &&
          incomingDep.specifierType !== "url" &&
          bundle.hasDependency(incomingDep)
        ) {
          bundleGraph.internalizeAsyncDependency(bundle, incomingDep)
        }
      }
    }
  }

  // Step Add to BundleGroups: Add bundles to their bundle groups
  idealBundleGraph.traverse((nodeId, _, actions) => {
    const node = idealBundleGraph.getNode(nodeId)

    if (node === "root") {
      return
    }

    actions.skipChildren()
    const outboundNodeIds = idealBundleGraph.getNodeIdsConnectedFrom(nodeId)
    const entryBundle = nullthrows(idealBundleGraph.getNode(nodeId))
    invariant(entryBundle !== "root")
    const legacyEntryBundle = nullthrows(
      idealBundleToLegacyBundle.get(entryBundle)
    )

    for (const id of outboundNodeIds) {
      const siblingBundle = nullthrows(idealBundleGraph.getNode(id))
      invariant(siblingBundle !== "root")
      const legacySiblingBundle = nullthrows(
        idealBundleToLegacyBundle.get(siblingBundle)
      )
      bundleGraph.createBundleReference(legacyEntryBundle, legacySiblingBundle)
    }
  })

  // Step References: Add references to all bundles
  for (const [asset, references] of idealGraph.assetReference) {
    for (const [dependency, bundle] of references) {
      const legacyBundle = nullthrows(idealBundleToLegacyBundle.get(bundle))
      bundleGraph.createAssetReference(dependency, asset, legacyBundle)
    }
  }

  for (const { from, to } of idealBundleGraph.getAllEdges()) {
    const sourceBundle = nullthrows(idealBundleGraph.getNode(from))

    if (sourceBundle === "root") {
      continue
    }

    invariant(sourceBundle !== "root")
    const legacySourceBundle = nullthrows(
      idealBundleToLegacyBundle.get(sourceBundle)
    )
    const targetBundle = nullthrows(idealBundleGraph.getNode(to))

    if (targetBundle === "root") {
      continue
    }

    invariant(targetBundle !== "root")
    const legacyTargetBundle = nullthrows(
      idealBundleToLegacyBundle.get(targetBundle)
    )
    bundleGraph.createBundleReference(legacySourceBundle, legacyTargetBundle)
  }
}
