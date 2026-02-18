interface ResultType<T = any> {
  success: boolean;
  code: number;
  message: string;
  data?: T;
  error?: any
}

export type { ResultType };
