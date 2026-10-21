export interface Startup {
  startupError: string | null; // set instead of rejecting, so the page can show it
  sessionsPersist: boolean; // false: recorded logins are forgotten when the app quits
}
