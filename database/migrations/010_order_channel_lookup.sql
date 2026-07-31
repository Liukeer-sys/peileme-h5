CREATE INDEX IF NOT EXISTS orders_user_product_channel_created_id_idx
  ON orders(user_id, product_channel, created_at DESC, id DESC);
