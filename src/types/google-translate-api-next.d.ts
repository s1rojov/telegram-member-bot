declare module 'google-translate-api-next' {
  export type TranslateOptions = {
    from?: string;
    to?: string;
    forceFrom?: boolean;
    forceTo?: boolean;
    raw?: boolean;
    requestFunction?: 'fetch' | 'axios';
    client?: 't' | 'gtx';
    tld?: string;
    refresh?: boolean;
  };

  export type TranslateResponse = {
    text: string;
    from: {
      language: {
        didYouMean: boolean;
        iso: string;
      };
      text:
        | {
            autoCorrected: boolean;
            value: string;
            didYouMean: boolean;
          }
        | '';
    };
    raw?: string;
  };

  export default function translate(
    text: string | string[] | Record<string, string>,
    options?: TranslateOptions,
    requestOptions?: unknown,
  ):
    | Promise<TranslateResponse>
    | Promise<TranslateResponse[]>
    | Promise<Record<string, TranslateResponse>>;
}
