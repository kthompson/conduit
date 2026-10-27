import { createContext, useContext } from "react";

/** Server render passes the CSP nonce down; on the client the browser hides it, so it is empty. */
export const NonceContext = createContext("");
export const useNonce = () => useContext(NonceContext);
