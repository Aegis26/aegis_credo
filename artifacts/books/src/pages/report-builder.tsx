import { useState } from "react";
import {
  useRunCustomReport,
  useListOrgDimensions,
  useCreateOrgDimension,
  getListOrgDimensionsQueryKey,
  RunReportRequestGroupByItem,
  RunReportRequestFiltersAccountTypesItem,
  CreateDimensionRequestType,
  type RunReportRequestGroupByItem as GroupByItem,
  type RunReportRequestFiltersAccountTypesItem as AccountTypeItem,
  type CustomReportResult,
  type CreateDimensionRequestType as DimType,
} from "@workspace/api-client-react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Play, Tags } from "lucide-react";

const GROUP_BY_OPTIONS: { value: GroupByItem; label: string }[] = [
  { value: RunReportRequestGroupByItem.account, label: "Account" },
  { value: RunReportRequestGroupByItem.accountType, label: "Account type" },
  { value: RunReportRequestGroupByItem.class, label: "Class" },
  { value: RunReportRequestGroupByItem.department, label: "Department" },
  { value: RunReportRequestGroupByItem.location, label: "Location" },
  { value: RunReportRequestGroupByItem.entity, label: "Entity" },
];

const ACCOUNT_TYPE_OPTIONS: { value: AccountTypeItem; label: string }[] = [
  { value: RunReportRequestFiltersAccountTypesItem.asset, label: "Asset" },
  { value: RunReportRequestFiltersAccountTypesItem.liability, label: "Liability" },
  { value: RunReportRequestFiltersAccountTypesItem.equity, label: "Equity" },
  { value: RunReportRequestFiltersAccountTypesItem.revenue, label: "Revenue" },
  { value: RunReportRequestFiltersAccountTypesItem.expense, label: "Expense" },
];

export default function ReportBuilder() {
  const { orgId } = useCurrentOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [groupBy, setGroupBy] = useState<GroupByItem[]>([RunReportRequestGroupByItem.accountType]);
  const [accountTypes, setAccountTypes] = useState<AccountTypeItem[]>([]);
  const [classIds, setClassIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [result, setResult] = useState<CustomReportResult | null>(null);

  const [dimOpen, setDimOpen] = useState(false);
  const [dimType, setDimType] = useState<DimType>(CreateDimensionRequestType.class);
  const [dimName, setDimName] = useState("");

  const { data: dimData } = useListOrgDimensions(orgId || "", {
    query: { enabled: !!orgId, queryKey: getListOrgDimensionsQueryKey(orgId || "") },
  });

  const runReport = useRunCustomReport();
  const createDimension = useCreateOrgDimension();

  const dimensions = dimData?.dimensions ?? [];
  const classes = dimensions.filter((d) => d.type === "class");
  const departments = dimensions.filter((d) => d.type === "department");
  const locations = dimensions.filter((d) => d.type === "location");

  const toggle = <T,>(list: T[], value: T, setter: (v: T[]) => void) => {
    setter(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  const handleRun = async () => {
    if (!orgId || groupBy.length === 0) return;
    try {
      const res = await runReport.mutateAsync({
        orgId,
        data: {
          groupBy,
          filters: {
            accountTypes: accountTypes.length ? accountTypes : undefined,
            classIds: classIds.length ? classIds : undefined,
            departmentIds: departmentIds.length ? departmentIds : undefined,
            locationIds: locationIds.length ? locationIds : undefined,
          },
        },
      });
      setResult(res);
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not run the report." });
    }
  };

  const handleCreateDimension = async () => {
    if (!orgId || !dimName.trim()) return;
    try {
      await createDimension.mutateAsync({ orgId, data: { type: dimType, name: dimName.trim() } });
      toast({ title: "Dimension created", description: `${dimName} added.` });
      setDimName("");
      setDimOpen(false);
      queryClient.invalidateQueries({ queryKey: getListOrgDimensionsQueryKey(orgId) });
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not create the dimension." });
    }
  };

  if (!orgId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Report Builder</h1>
          <p className="text-muted-foreground mt-1">
            Group and filter your ledger by class, department, and location.
          </p>
        </div>
        <Dialog open={dimOpen} onOpenChange={setDimOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="gap-2">
              <Tags className="w-4 h-4" />
              New dimension
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create a dimension</DialogTitle>
              <DialogDescription>Add a class, department, or location to tag transactions.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={dimType} onValueChange={(v) => setDimType(v as DimType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="class">Class</SelectItem>
                    <SelectItem value="department">Department</SelectItem>
                    <SelectItem value="location">Location</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input placeholder="e.g. West Region" value={dimName} onChange={(e) => setDimName(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreateDimension} disabled={createDimension.isPending || !dimName.trim()}>
                {createDimension.isPending ? "Saving..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Configure</CardTitle>
          <CardDescription>Choose how to group and filter your report.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <Label className="mb-3 block">Group by</Label>
            <div className="flex flex-wrap gap-4">
              {GROUP_BY_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={groupBy.includes(opt.value)}
                    onCheckedChange={() => toggle(groupBy, opt.value, setGroupBy)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <Label className="mb-3 block">Account types</Label>
            <div className="flex flex-wrap gap-4">
              {ACCOUNT_TYPE_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={accountTypes.includes(opt.value)}
                    onCheckedChange={() => toggle(accountTypes, opt.value, setAccountTypes)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          {classes.length > 0 && (
            <div>
              <Label className="mb-3 block">Classes</Label>
              <div className="flex flex-wrap gap-4">
                {classes.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={classIds.includes(d.id)}
                      onCheckedChange={() => toggle(classIds, d.id, setClassIds)}
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {departments.length > 0 && (
            <div>
              <Label className="mb-3 block">Departments</Label>
              <div className="flex flex-wrap gap-4">
                {departments.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={departmentIds.includes(d.id)}
                      onCheckedChange={() => toggle(departmentIds, d.id, setDepartmentIds)}
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {locations.length > 0 && (
            <div>
              <Label className="mb-3 block">Locations</Label>
              <div className="flex flex-wrap gap-4">
                {locations.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={locationIds.includes(d.id)}
                      onCheckedChange={() => toggle(locationIds, d.id, setLocationIds)}
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <Button onClick={handleRun} disabled={runReport.isPending || groupBy.length === 0} className="gap-2">
              {runReport.isPending ? <Spinner className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              Run report
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Result</CardTitle>
            <CardDescription>
              Grouped by{" "}
              {groupBy.map((g) => (
                <Badge key={g} variant="outline" className="mr-1 capitalize">
                  {g}
                </Badge>
              ))}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {result.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data for this selection.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Group</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.map((row, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          {Object.values(row.keys).filter(Boolean).join(" · ") || "—"}
                        </TableCell>
                        <TableCell className="text-right">${row.debit}</TableCell>
                        <TableCell className="text-right">${row.credit}</TableCell>
                        <TableCell className="text-right">${row.balance}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-bold bg-muted/20">
                      <TableCell>Total</TableCell>
                      <TableCell className="text-right">${result.totalDebit}</TableCell>
                      <TableCell className="text-right">${result.totalCredit}</TableCell>
                      <TableCell className="text-right" />
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
