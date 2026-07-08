import { useState, useEffect } from "react";

export function useCurrentOrg(orgs?: { id: string; name: string }[]) {
  const [orgId, setOrgId] = useState<string | null>(null);

  useEffect(() => {
    if (!orgs || orgs.length === 0) {
      setOrgId(null);
      return;
    }

    const saved = localStorage.getItem("books_current_org");
    if (saved && orgs.some((o) => o.id === saved)) {
      setOrgId(saved);
    } else {
      const first = orgs[0].id;
      localStorage.setItem("books_current_org", first);
      setOrgId(first);
    }
  }, [orgs]);

  const setOrg = (id: string) => {
    localStorage.setItem("books_current_org", id);
    setOrgId(id);
  };

  return { orgId, setOrg };
}
