import type { HttpMethod } from './types';
import type { Fetcher } from './interfaces/fetcher';

/**
 * Serialize a form to FormData, handling all standard input types
 */
export function serializeForm(form: HTMLFormElement): FormData {
  return new FormData(form);
}

/**
 * Convert FormData to URLSearchParams for GET requests
 */
export function formDataToParams(formData: FormData): URLSearchParams {
  const params = new URLSearchParams();
  formData.forEach((value, key) => {
    if (typeof value === 'string') {
      params.append(key, value);
    }
  });
  return params;
}

/**
 * Merge additional values into FormData
 * Values can be provided as a JSON string or object
 */
export function mergeValues(
  formData: FormData,
  values: string | Record<string, unknown>
): FormData {
  const parsed = typeof values === 'string' ? JSON.parse(values) : values;

  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && value !== null) {
      formData.append(key, String(value));
    }
  }

  return formData;
}

/**
 * Get the submit button that was clicked (if any)
 */
export function getSubmitButton(form: HTMLFormElement): HTMLButtonElement | HTMLInputElement | null {
  // Check if the form was submitted by a specific button
  const activeElement = document.activeElement;

  if (
    activeElement &&
    (activeElement instanceof HTMLButtonElement || activeElement instanceof HTMLInputElement) &&
    activeElement.form === form &&
    activeElement.type === 'submit'
  ) {
    return activeElement;
  }

  return null;
}

/**
 * Include the submit button's name/value in the form data if present
 */
export function includeSubmitButton(
  formData: FormData,
  submitter: HTMLButtonElement | HTMLInputElement | null
): void {
  if (submitter && submitter.name && submitter.value) {
    formData.set(submitter.name, submitter.value);
  }
}

/**
 * Validate a form using HTML5 validation
 * Returns true if valid, false otherwise
 */
export function validateFormHTML5(form: HTMLFormElement): boolean {
  return form.checkValidity();
}

/**
 * Report validity errors visually
 */
export function reportValidity(form: HTMLFormElement): void {
  form.reportValidity();
}

/**
 * Determine the HTTP method from a form element
 */
export function getFormMethod(form: HTMLFormElement, attributePrefix: string): HttpMethod {
  // Check for Hype-specific method attributes first
  const attrs = [
    `${attributePrefix}-get`,
    `${attributePrefix}-post`,
    `${attributePrefix}-put`,
    `${attributePrefix}-delete`,
    `${attributePrefix}-patch`,
  ] as const;

  for (const attr of attrs) {
    if (form.hasAttribute(attr)) {
      const method = attr.replace(`${attributePrefix}-`, '').toUpperCase();
      return method as HttpMethod;
    }
  }

  // Fall back to form's native method
  const method = form.getAttribute('method')?.toUpperCase() || 'GET';

  if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    return method as HttpMethod;
  }

  return 'POST';
}

/**
 * Get the form's action URL
 */
export function getFormAction(form: HTMLFormElement, attributePrefix: string): string {
  // Check for Hype-specific action attributes
  const attrs = [
    `${attributePrefix}-get`,
    `${attributePrefix}-post`,
    `${attributePrefix}-put`,
    `${attributePrefix}-delete`,
    `${attributePrefix}-patch`,
  ] as const;

  for (const attr of attrs) {
    const url = form.getAttribute(attr);
    if (url) {
      return url;
    }
  }

  // Fall back to form's native action
  return form.action || window.location.href;
}

/**
 * Prepare the body for a fetch request based on method and encoding
 */
export function prepareRequestBody(
  method: HttpMethod,
  formData: FormData,
  encoding?: string
): { body: BodyInit | undefined; contentType?: string } {
  // GET and DELETE typically don't have a body
  if (method === 'GET') {
    return { body: undefined };
  }

  // Check encoding preference
  if (encoding === 'application/json') {
    const obj: Record<string, unknown> = {};
    formData.forEach((value, key) => {
      // Handle array notation (e.g., "items[]")
      if (key.endsWith('[]')) {
        const arrayKey = key.slice(0, -2);
        if (!obj[arrayKey]) {
          obj[arrayKey] = [];
        }
        (obj[arrayKey] as unknown[]).push(value);
      } else {
        obj[key] = value;
      }
    });
    return {
      body: JSON.stringify(obj),
      contentType: 'application/json',
    };
  }

  if (encoding === 'application/x-www-form-urlencoded') {
    return {
      body: formDataToParams(formData),
      contentType: 'application/x-www-form-urlencoded',
    };
  }

  // Default to FormData (multipart/form-data is automatic)
  return { body: formData };
}

/**
 * Submit a form using the Fetcher abstraction.
 *
 * - `form`: the HTMLFormElement to submit
 * - `attributePrefix`: attribute prefix used by Hype to determine custom action/method attributes
 * - `fetcher`: optional Fetcher implementation (defaults to global fetch)
 * - `options`:
 *    - includeSubmitter: if true, include the clicked submit button's name/value
 *    - encoding: override encoding (e.g. 'application/json', 'application/x-www-form-urlencoded')
 *    - credentials: Request credentials (defaults to 'same-origin')
 *
 * Returns the raw Response from the underlying fetcher so callers can decide how to parse it.
 */
export async function submitForm(
  form: HTMLFormElement,
  attributePrefix: string,
  fetcher?: Fetcher,
  options?: { includeSubmitter?: boolean; encoding?: string; credentials?: RequestCredentials }
): Promise<Response> {
  const method = getFormMethod(form, attributePrefix);
  const action = getFormAction(form, attributePrefix);

  // serialize form and optionally include submitter
  let formData = serializeForm(form);
  if (options && options.includeSubmitter) {
    const submitter = getSubmitButton(form);
    includeSubmitButton(formData, submitter);
  }

  // encoding precedence: explicit option -> data-attribute on form -> undefined
  const encoding = options?.encoding || form.getAttribute(`data-${attributePrefix}-encoding`) || undefined;
  const { body, contentType } = prepareRequestBody(method, formData, encoding);

  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;

  const init: RequestInit = {
    method,
    credentials: options?.credentials ?? 'same-origin',
    headers,
    body: body as BodyInit,
  };

  const usedFetch = fetcher ?? ((input: RequestInfo, init?: RequestInit) => fetch(input, init));
  const resp = await usedFetch(action, init);
  return resp;
}
