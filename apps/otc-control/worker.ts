import { DurableObject } from 'cloudflare:workers';
import { handleControl } from './handler';

interface Env {
  CONTROL: DurableObjectNamespace<OtcControl>;
  OTC_CONTROL_TOKEN?: string;
}

export class OtcControl extends DurableObject<Env> {
  async read(): Promise<unknown> {
    return this.ctx.storage.get('control');
  }
  async write(value: { enabled: boolean; expiresAt: number }): Promise<void> {
    await this.ctx.storage.put('control', value);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // ponytail: one shared Ethereum switch; partition only when another network is admitted.
    return handleControl(request, env.CONTROL.getByName('ethereum-mainnet'), env.OTC_CONTROL_TOKEN);
  },
};
