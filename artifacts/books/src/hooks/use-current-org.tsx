import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useListMyOrgs, type Org } from "@workspace/api-client-react";

interface CurrentOrgValue {
  orgId: string | null;
  setOrg: (id: string) => void;
  orgs: Org[];
  isLoading: boolean;
}

const STORAGE_KEY = "books_current_org";

const CurrentOrgContext = createContext<CurrentOrgValue | null>(null);

export function CurrentOrgProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useListMyOrgs();
  const orgs = data?.orgs;
  const [orgId, setOrgId] = useState<string | null>(null);

  useEffect(() => {
    if (!orgs || orgs.length === 0) {
      setOrgId(null);
      return;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && orgs.some((o) => o.id === saved)) {
      setOrgId(saved);
    } else {
      const first = orgs[0].id;
      localStorage.setItem(STORAGE_KEY, first);
      setOrgId(first);
    }
  }, [orgs]);

  const setOrg = (id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    setOrgId(id);
  };

  return (
    <CurrentOrgContext.Provider value={{ orgId, setOrg, orgs: orgs ?? [], isLoading }}>
      {children}
    </CurrentOrgContext.Provider>
  );
}

export function useCurrentOrg(): CurrentOrgValue {
  const ctx = useContext(CurrentOrgContext);
  if (!ctx) {
    throw new Error("useCurrentOrg must be used within a CurrentOrgProvider");
  }
  return ctx;
}
