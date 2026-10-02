import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeJSON } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { withRegistryLock } from '../core/registry-lock.js';

const VERSION = 1;

export function projectsFile() {
  const home = process.env.MORAGENT_HOME?.trim();
  return path.join(home ? path.resolve(home) : path.join(os.homedir(), '.moragent'), 'projects.json');
}

function readRegistry() {
  const file = projectsFile();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: VERSION, projects: [] };
    throw new MoragentError('BAD_PROJECT_REGISTRY', `Cannot read project registry: ${file}`, 'Repair or restore projects.json before retrying.');
  }
  if (data?.version !== VERSION || !Array.isArray(data.projects) ||
      !data.projects.every((p) => p && typeof p.projectId === 'string' && typeof p.root === 'string' && typeof p.name === 'string')) {
    throw new MoragentError('BAD_PROJECT_REGISTRY', `Invalid project registry: ${file}`, 'Repair or restore projects.json before retrying.');
  }
  return data;
}

function directoryRoot(input) {
  const candidate = path.resolve(input || process.cwd());
  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch {
    throw new MoragentError('NO_DIRECTORY', `Directory does not exist: ${candidate}`);
  }
  if (!stat.isDirectory()) throw new MoragentError('NOT_DIRECTORY', `Not a directory: ${candidate}`);
  return fs.realpathSync(candidate);
}

function gitValue(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function listProjects() {
  return readRegistry().projects;
}

export function registerProject(input, { name } = {}) {
  const root = directoryRoot(input);
  const projectName = name === undefined ? path.basename(root) || root : String(name).trim();
  if (!projectName) throw new MoragentError('BAD_PROJECT_NAME', 'Project name cannot be empty.');
  const gitRoot = gitValue(root, ['rev-parse', '--show-toplevel']);
  const project = {
    projectId: `p-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`,
    name: projectName,
    root,
    kind: gitRoot ? 'git' : 'directory',
    ...(gitRoot ? { gitRoot: fs.realpathSync(gitRoot), branch: gitValue(root, ['branch', '--show-current']) } : {}),
    addedAt: new Date().toISOString(),
  };
  return withRegistryLock(projectsFile(), () => {
    const registry = readRegistry();
    const existing = registry.projects.find((p) => p.root === root);
    if (existing) return { project: existing, created: false };
    registry.projects.push(project);
    writeJSON(projectsFile(), registry);
    return { project, created: true };
  });
}

export function resolveProject(selector) {
  const projects = listProjects();
  if (!selector) throw new MoragentError('PROJECT_REQUIRED', 'Provide a project ID, name, or path.');
  const candidate = path.resolve(selector);
  const canonical = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
  const matches = projects.filter((p) => p.projectId === selector || p.name === selector || p.root === canonical);
  if (matches.length > 1) throw new MoragentError('AMBIGUOUS_PROJECT', `Several projects match: ${selector}`, 'Use the project ID shown by mora project list.');
  if (!matches.length) throw new MoragentError('UNKNOWN_PROJECT', `Unknown project: ${selector}`, 'Run mora project list.');
  const project = matches[0];
  if (!fs.existsSync(project.root)) throw new MoragentError('PROJECT_MISSING', `Project directory is missing: ${project.root}`);
  return project;
}
