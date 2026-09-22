#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const SOURCE_PACKAGE_JSON = path.join(SOURCE_ROOT, 'package.json');

const DEFAULT_FILES = {
  backend: [
    'server/services/pdfAnnotator.js',
    'server/services/feedbackVideoService.js',
    'server/routes/mark.js',
    'server/routes/results.js'
  ],
  frontend: [
    'client/src/services/api.ts',
    'client/src/components/MarkingInterface.tsx',
    'client/src/components/ResultsDashboard.tsx'
  ]
};

const REQUIRED_DEPENDENCIES = ['pdf-lib', 'pdfjs-dist', 'openai'];

function parseArgs(argv) {
  const options = {
    target: '',
    dryRun: false,
    backendOnly: false,
    install: true,
    buildClient: true,
    runDbInit: true,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--backend-only') {
      options.backendOnly = true;
      continue;
    }
    if (arg === '--no-install') {
      options.install = false;
      continue;
    }
    if (arg === '--no-build') {
      options.buildClient = false;
      continue;
    }
    if (arg === '--no-db-init') {
      options.runDbInit = false;
      continue;
    }

    if (arg === '--target') {
      options.target = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--target=')) {
      options.target = arg.split('=').slice(1).join('=');
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.backendOnly) {
    options.buildClient = false;
  }

  return options;
}

function printHelp() {
  console.log(`
Deploy annotation + feedback-video functionality into a partial MarkMate app.

Usage:
  node scripts/deploy-annotation-video-feedback.js --target <path> [options]

Options:
  --target <path>     Root path of the client app to patch
  --dry-run           Show what would change without writing files
  --backend-only      Deploy backend files only (skip client files/build)
  --no-install        Skip npm install steps
  --no-build          Skip client build step
  --no-db-init        Skip DB initialization/migration bootstrap
  --help, -h          Show this help

Examples:
  node scripts/deploy-annotation-video-feedback.js --target ../client-markmate
  node scripts/deploy-annotation-video-feedback.js --target C:\\apps\\markmate --dry-run
  node scripts/deploy-annotation-video-feedback.js --target ../client-markmate --backend-only --no-build
`);
}

function ensureExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function mkdirp(dirPath, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyWithBackup(relPath, targetRoot, backupRoot, dryRun) {
  const sourcePath = path.join(SOURCE_ROOT, relPath);
  const targetPath = path.join(targetRoot, relPath);
  const backupPath = path.join(backupRoot, relPath);

  ensureExists(sourcePath, 'Source file');

  if (fs.existsSync(targetPath)) {
    console.log(`Backup: ${relPath}`);
    mkdirp(path.dirname(backupPath), dryRun);
    if (!dryRun) {
      fs.copyFileSync(targetPath, backupPath);
    }
  } else {
    console.log(`Create: ${relPath} (new file in target)`);
  }

  console.log(`Deploy: ${relPath}`);
  mkdirp(path.dirname(targetPath), dryRun);
  if (!dryRun) {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function syncDependencies(targetRoot, dryRun) {
  const sourcePkg = readJson(SOURCE_PACKAGE_JSON);
  const targetPkgPath = path.join(targetRoot, 'package.json');
  ensureExists(targetPkgPath, 'Target package.json');
  const targetPkg = readJson(targetPkgPath);

  if (!targetPkg.dependencies) targetPkg.dependencies = {};
  let changed = false;

  REQUIRED_DEPENDENCIES.forEach((dep) => {
    const wanted = sourcePkg.dependencies && sourcePkg.dependencies[dep];
    if (!wanted) return;
    if (!targetPkg.dependencies[dep]) {
      targetPkg.dependencies[dep] = wanted;
      changed = true;
      console.log(`Dependency add: ${dep}@${wanted}`);
    }
  });

  if (changed && !dryRun) {
    writeJson(targetPkgPath, targetPkg);
  }

  return changed;
}

function patchResultsAuthFallback(targetRoot, dryRun) {
  const filePath = path.join(targetRoot, 'server/routes/results.js');
  if (!fs.existsSync(filePath)) return false;
  const input = fs.readFileSync(filePath, 'utf8');

  if (input.includes('requireFeature || (() => (req, res, next) => next())')) {
    return false;
  }

  const from = "const { requireAuth, requireFeature } = require('../middleware/auth');";
  const to = [
    "const authMiddleware = require('../middleware/auth');",
    'const requireAuth = authMiddleware.requireAuth;',
    "const requireFeature = authMiddleware.requireFeature || (() => (req, res, next) => next());"
  ].join('\n');

  if (!input.includes(from)) {
    console.log('Warning: Could not apply auth fallback patch in server/routes/results.js');
    return false;
  }

  console.log('Patch: server/routes/results.js (feature-flag fallback)');
  if (!dryRun) {
    fs.writeFileSync(filePath, input.replace(from, to), 'utf8');
  }
  return true;
}

function ensureRuntimeDirs(targetRoot, dryRun) {
  const dirs = [
    path.join(targetRoot, 'server/uploads/feedback-videos'),
    path.join(targetRoot, 'server/uploads/feedback-videos/temp')
  ];
  dirs.forEach((dir) => {
    console.log(`Ensure dir: ${path.relative(targetRoot, dir)}`);
    mkdirp(dir, dryRun);
  });
}

function runCommand(command, args, cwd) {
  const cmdString = [command, ...args].join(' ');
  console.log(`Run: ${cmdString} (cwd: ${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmdString}`);
  }
}

function hasClientApp(targetRoot) {
  return fs.existsSync(path.join(targetRoot, 'client/package.json'));
}

function runDbInit(targetRoot) {
  runCommand(
    'node',
    [
      '-e',
      "const db=require('./server/database/connection');Promise.resolve(db.initDatabase()).then(()=>{console.log('Database init complete');process.exit(0);}).catch((e)=>{console.error(e);process.exit(1);});"
    ],
    targetRoot
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.target) {
    throw new Error('Missing required --target <path>');
  }

  const targetRoot = path.resolve(process.cwd(), options.target);
  ensureExists(targetRoot, 'Target directory');
  ensureExists(path.join(targetRoot, 'package.json'), 'Target package.json');
  ensureExists(path.join(targetRoot, 'server/index.js'), 'Target server/index.js');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(targetRoot, '.feature-backups', `annotation-video-${timestamp}`);
  const filesToDeploy = [
    ...DEFAULT_FILES.backend,
    ...(options.backendOnly ? [] : DEFAULT_FILES.frontend)
  ];

  console.log('');
  console.log('==============================================');
  console.log('Annotation + Video Feedback Feature Deployment');
  console.log('==============================================');
  console.log(`Source: ${SOURCE_ROOT}`);
  console.log(`Target: ${targetRoot}`);
  console.log(`Dry run: ${options.dryRun ? 'yes' : 'no'}`);
  console.log(`Backup dir: ${backupRoot}`);
  console.log('');

  filesToDeploy.forEach((relPath) => {
    copyWithBackup(relPath, targetRoot, backupRoot, options.dryRun);
  });

  syncDependencies(targetRoot, options.dryRun);
  patchResultsAuthFallback(targetRoot, options.dryRun);
  ensureRuntimeDirs(targetRoot, options.dryRun);

  if (!options.dryRun && options.install) {
    runCommand('npm', ['install'], targetRoot);
    if (!options.backendOnly && hasClientApp(targetRoot)) {
      runCommand('npm', ['install'], path.join(targetRoot, 'client'));
    }
  }

  if (!options.dryRun && options.buildClient && !options.backendOnly && hasClientApp(targetRoot)) {
    runCommand('npm', ['run', 'build'], path.join(targetRoot, 'client'));
  }

  if (!options.dryRun && options.runDbInit) {
    runDbInit(targetRoot);
  }

  console.log('');
  console.log('Deployment finished.');
  if (options.dryRun) {
    console.log('No files were changed because --dry-run was enabled.');
  } else {
    console.log(`Backups saved under: ${backupRoot}`);
    console.log('Next: restart the server process on the client environment.');
  }
}

try {
  main();
} catch (error) {
  console.error('');
  console.error('Deployment failed.');
  console.error(error.message);
  process.exit(1);
}

