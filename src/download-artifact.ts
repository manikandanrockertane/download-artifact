import * as os from 'os'
import * as path from 'path'
import * as core from '@actions/core'
import artifactClient from '@actions/artifact'
import type { Artifact, FindOptions } from '@actions/artifact'
import { Minimatch } from 'minimatch'
import { Inputs, Outputs } from './constants'

const PARALLEL_DOWNLOADS = 5
const MAX_RETRIES = parseInt(core.getInput('retry_attempts') || '3', 10)  // Default 3 retries
const RETRY_INTERVAL = parseInt(core.getInput('retry_interval') || '6', 10) * 1000 // Convert seconds to ms

export const chunk = <T>(arr: T[], n: number): T[][] =>
  arr.reduce((acc, cur, i) => {
    const index = Math.floor(i / n)
    acc[index] = [...(acc[index] || []), cur]
    return acc
  }, [] as T[][])

async function downloadArtifactWithRetry(artifactId: number, options: any, resolvedPath: string, attempt = 1): Promise<void> {
  try {
    core.info(`Attempt ${attempt}: Downloading artifact ID ${artifactId}`)
    await artifactClient.downloadArtifact(artifactId, {
      ...options,
      path: resolvedPath
    })
    core.info(`Successfully downloaded artifact ID ${artifactId}`)
  } catch (error) {
    core.warning(`Attempt ${attempt} failed: ${error.message}`)
    if (attempt < MAX_RETRIES) {
      core.info(`Retrying in ${RETRY_INTERVAL / 1000} seconds...`)
      await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL))
      return downloadArtifactWithRetry(artifactId, options, resolvedPath, attempt + 1)
    } else {
      throw new Error(`Failed to download artifact ID ${artifactId} after ${MAX_RETRIES} attempts`)
    }
  }
}

async function run(): Promise<void> {
  const inputs = {
    name: core.getInput(Inputs.Name, { required: false }),
    path: core.getInput(Inputs.Path, { required: false }),
    token: core.getInput(Inputs.GitHubToken, { required: false }),
    repository: core.getInput(Inputs.Repository, { required: false }),
    runID: parseInt(core.getInput(Inputs.RunID, { required: false })),
    pattern: core.getInput(Inputs.Pattern, { required: false }),
    mergeMultiple: core.getBooleanInput(Inputs.MergeMultiple, { required: false })
  }

  if (!inputs.path) {
    inputs.path = process.env['GITHUB_WORKSPACE'] || process.cwd()
  }

  if (inputs.path.startsWith(`~`)) {
    inputs.path = inputs.path.replace('~', os.homedir())
  }

  const isSingleArtifactDownload = !!inputs.name
  const resolvedPath = path.resolve(inputs.path)
  core.debug(`Resolved path is ${resolvedPath}`)

  const options: FindOptions = {}
  if (inputs.token) {
    const [repositoryOwner, repositoryName] = inputs.repository.split('/')
    if (!repositoryOwner || !repositoryName) {
      throw new Error(`Invalid repository: '${inputs.repository}'. Must be in format owner/repo`)
    }

    options.findBy = {
      token: inputs.token,
      workflowRunId: inputs.runID,
      repositoryName,
      repositoryOwner
    }
  }

  let artifacts: Artifact[] = []

  if (isSingleArtifactDownload) {
    core.info(`Downloading single artifact`)
    const { artifact: targetArtifact } = await artifactClient.getArtifact(inputs.name, options)

    if (!targetArtifact) {
      throw new Error(`Artifact '${inputs.name}' not found`)
    }

    core.debug(`Found named artifact '${inputs.name}' (ID: ${targetArtifact.id}, Size: ${targetArtifact.size})`)
    artifacts = [targetArtifact]
  } else {
    const listArtifactResponse = await artifactClient.listArtifacts({ latest: true, ...options })
    artifacts = listArtifactResponse.artifacts

    core.debug(`Found ${artifacts.length} artifacts in run`)

    if (inputs.pattern) {
      core.info(`Filtering artifacts by pattern '${inputs.pattern}'`)
      const matcher = new Minimatch(inputs.pattern)
      artifacts = artifacts.filter(artifact => matcher.match(artifact.name))
      core.debug(`Filtered from ${listArtifactResponse.artifacts.length} to ${artifacts.length} artifacts`)
    } else {
      core.info('No input name or pattern filter specified, downloading all artifacts')
      if (!inputs.mergeMultiple) {
        core.info('An extra directory with the artifact name will be created for each download')
      }
    }
  }

  if (artifacts.length) {
    core.info(`Preparing to download the following artifacts:`)
    artifacts.forEach(artifact => {
      core.info(`- ${artifact.name} (ID: ${artifact.id}, Size: ${artifact.size})`)
    })
  }

  const downloadPromises = artifacts.map(artifact => downloadArtifactWithRetry(artifact.id, options, resolvedPath))

  const chunkedPromises = chunk(downloadPromises, PARALLEL_DOWNLOADS)
  for (const chunk of chunkedPromises) {
    await Promise.all(chunk)
  }

  core.info(`Total of ${artifacts.length} artifact(s) downloaded`)
  core.setOutput(Outputs.DownloadPath, resolvedPath)
  core.info('Download artifact has finished successfully')
}

run().catch(err =>
  core.setFailed(`Unable to download artifact(s): ${err.message}`)
)