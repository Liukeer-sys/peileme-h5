import { useEffect, useState } from "react";
import { api } from "../lib/api";

type PublicAnnouncement = {
  id: string;
  title: string;
  body: string;
  revision: number;
};

export default function AnnouncementBanner() {
  const [items, setItems] = useState<PublicAnnouncement[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: PublicAnnouncement[] }>("/api/public/announcements", {
      signal: controller.signal
    })
      .then((response) => setItems(response.items))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!items.length) return null;

  return (
    <section className="public-announcements" aria-label="平台公告">
      {items.slice(0, 3).map((item) => (
        <article key={`${item.id}-${item.revision}`}>
          <strong>{item.title}</strong>
          <p>{item.body}</p>
        </article>
      ))}
    </section>
  );
}
