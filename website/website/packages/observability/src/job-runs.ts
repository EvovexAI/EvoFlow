export interface JobRunEvent {
  jobName: string;
  status: 'success' | 'error' | 'skipped';
}

export function createJobRunEvent(event: JobRunEvent): JobRunEvent {
  return event;
}

