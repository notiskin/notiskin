declare module 'chrome-remote-interface' {
  import { EventEmitter } from 'events';

  interface Options {
    host?: string;
    port?: number;
    target?: string;
    local?: boolean;
  }

  interface Target {
    id: string;
    type: string;
    url: string;
    title?: string;
    webSocketDebuggerUrl?: string;
  }

  interface Client extends EventEmitter {
    send(method: string, params?: object): Promise<object>;
    close(): Promise<void>;
    [domain: string]: any;
  }

  function CDP(options?: Options): Promise<Client>;
  namespace CDP {
    function List(options?: { host?: string; port?: number }): Promise<Target[]>;
    function Activate(options: { id: string; host?: string; port?: number }): Promise<void>;
  }

  export = CDP;
}
