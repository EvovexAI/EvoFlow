type ZCodeUserQuestionAnswers = Record<string, unknown>;

type AskUserQuestionType = "single" | "multiple";

interface AskUserQuestionOption {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  requiresInput: boolean;
}

interface AskUserQuestionItem {
  id: string;
  question: string;
  type: AskUserQuestionType;
  options: AskUserQuestionOption[];
  customInput?: AskUserQuestionOption;
}

interface AskUserQuestionData {
  questions: AskUserQuestionItem[];
  answers?: ZCodeUserQuestionAnswers;
}

interface AskUserQuestionAnswerDraft {
  selectedOptionIds: string[];
  customInput: string;
}

const CUSTOM_INPUT_FLAGS = [
  "requiresInput",
  "customInput",
  "isCustom",
  "freeText",
  "allowFreeText",
] as const;
const CUSTOM_INPUT_LABEL_PATTERN =
  /(其他|其它|自定义|自行|自己|补充|填写|填入|输入|other|custom|free\s*text|specify|write\s*in)/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[]) {
  return keys.some((key) => record[key] === true);
}

function normalizeOption(value: unknown, index: number): AskUserQuestionOption | null {
  if (typeof value === "string") {
    return {
      id: `option-${index}`,
      label: value,
      requiresInput: false,
    };
  }

  if (!isPlainRecord(value)) {
    return null;
  }

  const label =
    readString(value, ["label", "name", "title", "text", "value"]) ?? JSON.stringify(value);
  const id = readString(value, ["id", "optionId", "value", "key"]) ?? label;
  const placeholder = readString(value, [
    "placeholder",
    "customInputPlaceholder",
    "freeTextPlaceholder",
    "inputPlaceholder",
  ]);

  return {
    id,
    label,
    description: readString(value, ["description", "detail", "help", "hint"]),
    placeholder,
    requiresInput:
      readBoolean(value, CUSTOM_INPUT_FLAGS) || (index >= 0 && placeholder !== undefined),
  };
}

function isImplicitCustomInputOption(option: AskUserQuestionOption | undefined) {
  if (!option) {
    return false;
  }
  return CUSTOM_INPUT_LABEL_PATTERN.test(option.label);
}

function readQuestions(input: unknown): unknown[] {
  if (!isPlainRecord(input)) {
    return [];
  }
  const questions = input.questions;
  if (Array.isArray(questions)) {
    return questions;
  }
  // ZCode Agent 的单题输入与交互请求的多题输入共用展示管线。
  return typeof input.question === "string" && Array.isArray(input.options) ? [input] : [];
}

function readAnswers(input: unknown): ZCodeUserQuestionAnswers | undefined {
  if (!isPlainRecord(input)) {
    return undefined;
  }
  const answers = input.answers;
  return isPlainRecord(answers) ? answers : undefined;
}

function parseJsonRecord(output: unknown): Record<string, unknown> | undefined {
  if (isPlainRecord(output)) {
    return output;
  }
  if (typeof output !== "string" || output.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(output) as unknown;
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readNestedAskUserQuestionAnswers(input: unknown): ZCodeUserQuestionAnswers | undefined {
  const record = parseJsonRecord(input);
  if (!record) {
    return undefined;
  }

  const directAnswers = readAnswers(record);
  if (directAnswers) {
    return directAnswers;
  }

  const contentAnswers = readNestedAskUserQuestionAnswers(record.content);
  if (contentAnswers) {
    return contentAnswers;
  }

  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const itemAnswers = readNestedAskUserQuestionAnswers(item);
      if (itemAnswers) {
        return itemAnswers;
      }
    }
  }

  const rawOutputAnswers = readNestedAskUserQuestionAnswers(record.rawOutput);
  if (rawOutputAnswers) {
    return rawOutputAnswers;
  }

  return readNestedAskUserQuestionAnswers(record.output);
}

function parseZCodeAskUserQuestionOutput(
  output: unknown,
  input: unknown,
): ZCodeUserQuestionAnswers | undefined {
  const outputRecord = parseJsonRecord(output);
  if (!outputRecord) {
    return undefined;
  }

  const data = normalizeAskUserQuestionInput(input);
  const question = data.questions[0];
  if (!question) {
    return undefined;
  }

  const type = outputRecord.type;
  const rawAnswer =
    type === "answered"
      ? outputRecord.selected
      : type === "answered_custom"
        ? outputRecord.text
        : undefined;
  if (typeof rawAnswer !== "string") {
    return undefined;
  }

  return {
    [question.question]: rawAnswer,
  };
}

function normalizeQuestion(value: unknown, index: number): AskUserQuestionItem | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  const question = readString(value, ["question", "prompt", "label", "title", "text"]);
  if (!question) {
    return null;
  }

  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map((option, optionIndex) => normalizeOption(option, optionIndex))
    .filter((option): option is AskUserQuestionOption => option !== null);
  const questionPlaceholder = readString(value, [
    "customInputPlaceholder",
    "freeTextPlaceholder",
    "inputPlaceholder",
  ]);
  const lastOption = options.at(-1);
  const lastOptionIsCustomInput =
    lastOption !== undefined &&
    (lastOption.requiresInput === true || isImplicitCustomInputOption(lastOption));
  const customInput =
    lastOptionIsCustomInput && lastOption
      ? {
          ...lastOption,
          placeholder: lastOption.placeholder ?? lastOption.label,
          requiresInput: true,
        }
      : questionPlaceholder
        ? {
            id: `custom-${index}`,
            label: questionPlaceholder,
            placeholder: questionPlaceholder,
            requiresInput: true,
          }
        : undefined;
  const normalizedOptions = lastOptionIsCustomInput ? options.slice(0, -1) : options;
  const type =
    value.multiple === true ||
    value.multiSelect === true ||
    value.type === "multiple" ||
    value.type === "multi"
      ? "multiple"
      : "single";

  return {
    id: readString(value, ["id", "key", "name"]) ?? `question-${index}`,
    question,
    type,
    options: normalizedOptions,
    customInput,
  };
}

export function normalizeAskUserQuestionInput(input: unknown): AskUserQuestionData {
  return {
    questions: readQuestions(input)
      .map((question, index) => normalizeQuestion(question, index))
      .filter((question): question is AskUserQuestionItem => question !== null),
    answers: readAnswers(input),
  };
}

export function readAskUserQuestionInput(value: {
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}): unknown {
  if (readQuestions(value.input).length > 0) {
    return value.input;
  }
  if (isPlainRecord(value.raw)) {
    if (readQuestions(value.raw.rawInput).length > 0) {
      return value.raw.rawInput;
    }
    if (readQuestions(value.raw.input).length > 0) {
      return value.raw.input;
    }
  }
  return value.input;
}

export function readAskUserQuestionAnswers(value: {
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}): ZCodeUserQuestionAnswers | undefined {
  const nestedOutputAnswers = readNestedAskUserQuestionAnswers(value.output);
  if (nestedOutputAnswers) {
    return nestedOutputAnswers;
  }
  const parsedZCodeOutputAnswers = parseZCodeAskUserQuestionOutput(
    value.output,
    readAskUserQuestionInput(value),
  );
  if (parsedZCodeOutputAnswers) {
    return parsedZCodeOutputAnswers;
  }
  if (isPlainRecord(value.input) && isPlainRecord(value.input.answers)) {
    return value.input.answers;
  }
  if (isPlainRecord(value.raw)) {
    const nestedRawOutputAnswers = readNestedAskUserQuestionAnswers(value.raw.rawOutput);
    if (nestedRawOutputAnswers) {
      return nestedRawOutputAnswers;
    }
    const parsedRawZCodeOutputAnswers = parseZCodeAskUserQuestionOutput(
      value.raw.rawOutput,
      readAskUserQuestionInput(value),
    );
    if (parsedRawZCodeOutputAnswers) {
      return parsedRawZCodeOutputAnswers;
    }
    const nestedRawAnswers = readNestedAskUserQuestionAnswers(value.raw.output);
    if (nestedRawAnswers) {
      return nestedRawAnswers;
    }
    const parsedRawZCodeAnswers = parseZCodeAskUserQuestionOutput(
      value.raw.output,
      readAskUserQuestionInput(value),
    );
    if (parsedRawZCodeAnswers) {
      return parsedRawZCodeAnswers;
    }
    const nestedRawContentAnswers = readNestedAskUserQuestionAnswers(value.raw.content);
    if (nestedRawContentAnswers) {
      return nestedRawContentAnswers;
    }
  }
  return undefined;
}

export function getAskUserQuestionAnswerText(
  question: AskUserQuestionItem,
  answers: ZCodeUserQuestionAnswers | undefined,
  noAnswerText: string,
) {
  const value = answers?.[question.question] ?? answers?.[question.id];
  if (Array.isArray(value)) {
    const values = value.map((item) => String(item).trim()).filter((item) => item.length > 0);
    return values.length > 0 ? values.join("，") : noAnswerText;
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : noAnswerText;
  }
  if (value === undefined || value === null) {
    return noAnswerText;
  }
  return String(value);
}
