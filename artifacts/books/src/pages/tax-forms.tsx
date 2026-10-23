import { useCurrentOrg } from "@/hooks/use-current-org";
import { TaxFormsWorkspace } from "@/components/tax-forms-workspace";

export default function TaxForms() {
  const { orgId } = useCurrentOrg();
  if (!orgId) return null;
  return <TaxFormsWorkspace key={orgId} orgId={orgId} />;
}
