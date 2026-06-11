import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Local open-source transcription via whisper.cpp (SPEC.md section 2 ingest
 * breadth, section 10 privacy). No cloud STT: audio never leaves this machine.
 * Pipeline: ffmpeg converts the upload to 16kHz mono wav, then the whisper.cpp
 * CLI transcribes it to a text file we read back.
 *
 * All subprocess execution goes through an injectable Runner so tests can stub
 * it. Binary/model discovery uses process.env directly because config.ts is
 * frozen: WHISPER_CPP_PATH and WHISPER_MODEL_PATH override autodiscovery.
 */

export class SttError extends Error {}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string[]) => Promise<RunResult>;

export type WhichFn = (cmd: string) => string | null;

const SETUP_HINT = "Run: bash scripts/setup-whisper.sh";

const WHISPER_BINARY_NAMES = ["whisper-cli", "whisper-cpp", "whisper"];

const defaultWhich: WhichFn = (cmd) => Bun.which(cmd);

/** Real subprocess runner (Bun.spawn). Tests inject a stub instead. */
export const defaultRunner: Runner = async (cmd) => {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/** WHISPER_CPP_PATH if set, else the first known whisper.cpp CLI name on PATH. */
export function findWhisperBinary(which: WhichFn = defaultWhich): string | null {
  const fromEnv = process.env.WHISPER_CPP_PATH;
  if (fromEnv) return fromEnv;
  for (const name of WHISPER_BINARY_NAMES) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/** Where we expect the model to be (env override or the setup script default). */
export function modelCandidatePath(): string {
  return (
    process.env.WHISPER_MODEL_PATH ??
    join(homedir(), ".cache", "whisper", "ggml-large-v3-turbo.bin")
  );
}

/** Resolved model path, or null when the file does not exist. */
export function findModel(): string | null {
  const candidate = modelCandidatePath();
  return existsSync(candidate) ? candidate : null;
}

/** Preflight check used by GET /api/stt/status and the upload UI. */
export function sttAvailable(deps: { which?: WhichFn } = {}): { ok: boolean; missing: string[] } {
  const which = deps.which ?? defaultWhich;
  const missing: string[] = [];
  if (!which("ffmpeg")) missing.push("ffmpeg");
  if (!findWhisperBinary(which)) missing.push("whisper.cpp binary");
  if (!findModel()) missing.push(`whisper model (expected at ${modelCandidatePath()})`);
  return { ok: missing.length === 0, missing };
}

export interface TranscribeOpts {
  runner?: Runner;
  which?: WhichFn;
  /** Override binary/model resolution (tests, future per-meeting model choice). */
  binary?: string;
  model?: string;
}

function lastLines(s: string, n = 3): string {
  return s.trim().split("\n").slice(-n).join(" ").slice(0, 400);
}

/**
 * Transcribe an audio file to plain text using local whisper.cpp.
 * Throws SttError with an actionable message when a dependency is missing or
 * a subprocess fails. Temp files are always cleaned up.
 */
export async function transcribeAudio(audioPath: string, opts: TranscribeOpts = {}): Promise<string> {
  const which = opts.which ?? defaultWhich;
  const run = opts.runner ?? defaultRunner;

  const ffmpeg = which("ffmpeg");
  if (!ffmpeg) throw new SttError(`ffmpeg not found. ${SETUP_HINT}`);

  const binary = opts.binary ?? findWhisperBinary(which);
  if (!binary) {
    throw new SttError(
      `whisper.cpp binary not found (checked WHISPER_CPP_PATH and PATH for ${WHISPER_BINARY_NAMES.join(", ")}). ${SETUP_HINT}`,
    );
  }

  const model = opts.model ?? modelCandidatePath();
  if (!existsSync(model)) {
    throw new SttError(
      `Whisper model not found at ${model}. ${SETUP_HINT} (or set WHISPER_MODEL_PATH)`,
    );
  }

  const workDir = mkdtempSync(join(tmpdir(), "ie-stt-"));
  const wavPath = join(workDir, "audio-16k-mono.wav");
  const outBase = join(workDir, "transcript"); // whisper writes <outBase>.txt
  try {
    const ff = await run([
      ffmpeg,
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", audioPath,
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      wavPath,
    ]);
    if (ff.exitCode !== 0) {
      throw new SttError(`ffmpeg failed to convert ${audioPath}: ${lastLines(ff.stderr) || `exit code ${ff.exitCode}`}`);
    }

    const wr = await run([binary, "-m", model, "-f", wavPath, "-otxt", "-of", outBase, "-np"]);
    if (wr.exitCode !== 0) {
      throw new SttError(`whisper.cpp failed: ${lastLines(wr.stderr) || `exit code ${wr.exitCode}`}`);
    }

    const txtPath = `${outBase}.txt`;
    if (!existsSync(txtPath)) {
      throw new SttError(`whisper.cpp reported success but wrote no output at ${txtPath}. ${SETUP_HINT}`);
    }
    const text = readFileSync(txtPath, "utf8").trim();
    if (!text) throw new SttError("whisper.cpp produced an empty transcript (is the audio silent or corrupt?)");
    return text;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
