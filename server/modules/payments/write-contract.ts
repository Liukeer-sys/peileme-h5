import type { ClientBase } from "pg";

export const enableIdentityPaymentWrites = (client: ClientBase) =>
  client.query(
    `SELECT set_config(
       'peileme.payment_write_contract',
       'identity_v1:' || txid_current()::text,
       true
     )`
  );
