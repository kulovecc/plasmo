/**
 * Based on https://github.com/parcel-bundler/parcel/blob/v2/packages/core/core/src/resolveOptions.js
 * MIT License
 */

import { FSCache, LMDBCache } from "@parcel/cache"
import { toProjectPath } from "@parcel/core/lib/projectPath"
import { getResolveFrom } from "@parcel/core/lib/requests/ParcelConfigRequest"
import type { FileSystem } from "@parcel/fs"
import { NodeFS } from "@parcel/fs"
import { hashString } from "@parcel/hash"
import { NodePackageManager } from "@parcel/package-manager"
import type {
  DependencySpecifier,
  FilePath,
  InitialParcelOptions,
  InitialServerOptions
} from "@parcel/types"
import { getRootDir, isGlob, relativePath, resolveConfig } from "@parcel/utils"
import path from "path"

// Default cache directory name
const LOCK_FILE_NAMES = ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"]

// Generate a unique instanceId, will change on every run of parcel
function generateInstanceId(entries: Array<FilePath>): string {
  return hashString(
    `${entries.join(",")}-${Date.now()}-${Math.round(Math.random() * 100)}`
  )
}

export async function resolveOptions(initialOptions: InitialParcelOptions) {
  const inputFS = initialOptions.inputFS || new NodeFS()
  const outputFS = initialOptions.outputFS || new NodeFS()
  const inputCwd = inputFS.cwd()
  const outputCwd = outputFS.cwd()
  let entries: Array<FilePath>

  if (initialOptions.entries == null || initialOptions.entries === "") {
    entries = []
  } else if (Array.isArray(initialOptions.entries)) {
    entries = initialOptions.entries.map((entry) =>
      path.resolve(inputCwd, entry)
    )
  } else {
    entries = [path.resolve(inputCwd, initialOptions.entries)]
  }

  let shouldMakeEntryReferFolder = false

  if (entries.length === 1 && !isGlob(entries[0])) {
    const [entry] = entries

    try {
      shouldMakeEntryReferFolder = (await inputFS.stat(entry)).isDirectory()
    } catch {
      // ignore failing stat call
    }
  }

  // getRootDir treats the input as files, so getRootDir(["/home/user/myproject"]) returns "/home/user".
  // Instead we need to make the the entry refer to some file inside the specified folders if entries refers to the directory.
  const entryRoot = getRootDir(
    shouldMakeEntryReferFolder ? [path.join(entries[0], "index")] : entries
  )
  const projectRootFile =
    (await resolveConfig(
      inputFS,
      path.join(entryRoot, "index"),
      [...LOCK_FILE_NAMES],
      path.parse(entryRoot).root
    )) || path.join(inputCwd, "index")

  // ? Should this just be rootDir
  const projectRoot = path.dirname(projectRootFile)
  const packageManager =
    initialOptions.packageManager ||
    new NodePackageManager(inputFS, projectRoot)

  const cacheDir = path.resolve(outputCwd, initialOptions.cacheDir)

  const cache =
    initialOptions.cache ??
    (outputFS instanceof NodeFS
      ? new LMDBCache(cacheDir)
      : // @ts-ignore QUIRK: upstream def is outdated
        new FSCache(outputFS, cacheDir))

  const mode = initialOptions.mode ?? "development"
  const shouldOptimize =
    initialOptions?.defaultTargetOptions?.shouldOptimize ??
    mode === "production"
  const publicUrl = initialOptions?.defaultTargetOptions?.publicUrl ?? "/"
  const distDir =
    initialOptions?.defaultTargetOptions?.distDir != null
      ? path.resolve(inputCwd, initialOptions?.defaultTargetOptions?.distDir)
      : undefined
  const shouldBuildLazily = initialOptions.shouldBuildLazily ?? false
  const shouldContentHash =
    initialOptions.shouldContentHash ?? initialOptions.mode === "production"

  if (shouldBuildLazily && shouldContentHash) {
    throw new Error("Lazy bundling does not work with content hashing")
  }

  const env = initialOptions.env
  const port = determinePort(initialOptions.serveOptions, process.env.PORT)

  return {
    config: getRelativeConfigSpecifier(
      inputFS,
      projectRoot,
      initialOptions.config
    ),
    defaultConfig: getRelativeConfigSpecifier(
      inputFS,
      projectRoot,
      initialOptions.defaultConfig
    ),
    shouldPatchConsole: initialOptions.shouldPatchConsole ?? false,
    env,
    mode,
    shouldAutoInstall: initialOptions.shouldAutoInstall ?? false,
    hmrOptions: initialOptions.hmrOptions ?? null,
    shouldBuildLazily,
    shouldBundleIncrementally: initialOptions.shouldBundleIncrementally ?? true,
    shouldContentHash,
    serveOptions: initialOptions.serveOptions
      ? {
          ...initialOptions.serveOptions,
          distDir: distDir ?? path.join(outputCwd, "dist"),
          port
        }
      : false,
    shouldDisableCache: initialOptions.shouldDisableCache ?? false,
    shouldProfile: initialOptions.shouldProfile ?? false,
    cacheDir,
    entries: entries.map((e) => toProjectPath(projectRoot, e)),
    targets: initialOptions.targets,
    logLevel: initialOptions.logLevel ?? "info",
    projectRoot,
    inputFS,
    outputFS,
    cache,
    packageManager,
    additionalReporters:
      initialOptions.additionalReporters?.map(
        ({ packageName, resolveFrom }) => ({
          packageName,
          resolveFrom: toProjectPath(projectRoot, resolveFrom)
        })
      ) ?? [],
    instanceId: generateInstanceId(entries),
    detailedReport: initialOptions.detailedReport,
    defaultTargetOptions: {
      shouldOptimize,
      shouldScopeHoist: initialOptions?.defaultTargetOptions?.shouldScopeHoist,
      sourceMaps: initialOptions?.defaultTargetOptions?.sourceMaps ?? true,
      publicUrl,
      ...(distDir != null
        ? {
            distDir: toProjectPath(projectRoot, distDir)
          }
        : {
            /*::...null*/
          }),
      engines: initialOptions?.defaultTargetOptions?.engines,
      outputFormat: initialOptions?.defaultTargetOptions?.outputFormat,
      isLibrary: initialOptions?.defaultTargetOptions?.isLibrary
    }
  }
}

export type ResolvedOptions = Awaited<ReturnType<typeof resolveOptions>>

function getRelativeConfigSpecifier(
  fs: FileSystem,
  projectRoot: FilePath,
  specifier: DependencySpecifier | null | undefined
) {
  if (specifier == null) {
    return undefined
  } else if (path.isAbsolute(specifier)) {
    const resolveFrom = getResolveFrom(fs, projectRoot)
    const relative = relativePath(path.dirname(resolveFrom), specifier)
    // If the config is outside the project root, use an absolute path so that if the project root
    // moves the path still works. Otherwise, use a relative path so that the cache is portable.
    return relative.startsWith("..") ? specifier : relative
  } else {
    return specifier
  }
}

function determinePort(
  initialServerOptions: InitialServerOptions | false | void,
  portInEnv: string | void,
  defaultPort: number = 1234
): number {
  function parsePort(port: string) {
    const parsedPort = Number(port)

    // return undefined if port number defined in .env is not valid integer
    if (!Number.isInteger(parsedPort)) {
      return undefined
    }

    return parsedPort
  }

  if (!initialServerOptions) {
    return typeof portInEnv !== "undefined"
      ? parsePort(portInEnv) ?? defaultPort
      : defaultPort
  }

  // if initialServerOptions.port is equal to defaultPort, then this means that port number is provided via PORT=~~~~ on cli. In this case, we should ignore port number defined in .env.
  if (initialServerOptions.port !== defaultPort) {
    return initialServerOptions.port
  }

  return typeof portInEnv !== "undefined"
    ? parsePort(portInEnv) ?? defaultPort
    : defaultPort
}
