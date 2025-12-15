// Types
export type {
  HttpMethod,
  SwapStrategy,
  HypeEventName,
  HypeConfig,
  RequestContext,
  ResponseContext,
  HypeJsonResponse,
  RequestInterceptor,
  ResponseInterceptor,
  SwapHandler,
  ValidationFn,
  BeforeRequestDetail,
  BeforeSwapDetail,
  AfterSwapDetail,
  AfterSettleDetail,
  RequestErrorDetail,
  ResponseErrorDetail,
  HypeEventDetail,
  HypeEvent,
  HypeElement,
  HypeAttributes,
} from "./types";

// Renderer host interface (export so consumers/tests can inject/mock hosts)
export type { IRendererHost } from "./interfaces/renderer-host.interface";

// Event system
export { EventSystem, eventSystem } from "./events";

// Reactive system
export { ReactiveSystem, createReactive } from "./reactive";

// Interceptors
export { InterceptorRegistry, defaultSwap } from "./interceptors";

// Form utilities
export {
  serializeForm,
  formDataToParams,
  mergeValues,
  getSubmitButton,
  includeSubmitButton,
  validateFormHTML5,
  reportValidity,
  getFormMethod,
  getFormAction,
  prepareRequestBody,
} from "./form";

// Main Hype class
export { Hype, createHype, hype } from "./hype";

// Plugins and helpers (convenience exports)
// Export pubsub and behavior helpers so tests and consumers can import them directly from the package entrypoint.
// These are lightweight re-exports of the optional plugin modules and do not force the plugins to be attached to Hype.
export { createHypePubsub, attachToHype, pubsubPlugin } from "./plugins/pubsub";
export { createBehaviorRegistry, parseTriggerSpec, attachBehaviorsFromAttribute, attachDebounce, behaviorPlugin } from "./plugins/behavior";

// Default export
export { hype as default } from "./hype";
