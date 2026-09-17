export type global = object;

declare global {
  var ChakraUISystem: SystemContext | undefined;
  /** Build timestamp injected by Vite, so a cached tab can be spotted. */
  const __AOS_BUILD__: string;
}
