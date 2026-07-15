import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { 
  useSwitchToClient,
  useListClosePeriods,
  useGetCloseStatus,
  useCreateClosePeriod,
  useSetClosePeriodStatus,
  useAddCloseTask,
  useSetCloseTaskStatus,
  useCreatePbcRequest,
  useAcceptPbcRequest,
  getGetCloseStatusQueryKey,
  getListClosePeriodsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ArrowLeft, CheckCircle2, Clock, AlertCircle, Plus, FileText, CheckSquare, ListTodo, MoreVertical, Play, Check } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

export default function PracticeClientClose() {
  const { orgId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [accessDenied, setAccessDenied] = useState(false);
  const [activePeriodId, setActivePeriodId] = useState<string | null>(null);

  const switchMutation = useSwitchToClient();
  
  useEffect(() => {
    if (!orgId) return;
    switchMutation.mutate({ orgId }, {
      onError: (err: any) => {
        if (err.status === 403 || err.status === 401) {
          setAccessDenied(true);
        } else {
          toast({ title: "Error", description: "Could not access client.", variant: "destructive" });
          setLocation("/practice");
        }
      }
    });
  }, [orgId, setLocation, toast]);

  const { data: periodsData, isLoading: periodsLoading } = useListClosePeriods(orgId || "", {
    query: { queryKey: getListClosePeriodsQueryKey(orgId || ""), enabled: !!orgId && !accessDenied }
  });

  const periods = periodsData?.periods || [];
  
  useEffect(() => {
    if (periods.length > 0 && !activePeriodId) {
      setActivePeriodId(periods[0].id);
    }
  }, [periods, activePeriodId]);

  const { data: statusData, isLoading: statusLoading } = useGetCloseStatus(orgId || "", activePeriodId || "", {
    query: { queryKey: getGetCloseStatusQueryKey(orgId || "", activePeriodId || ""), enabled: !!orgId && !!activePeriodId && !accessDenied }
  });

  const createPeriod = useCreateClosePeriod();
  const setPeriodStatus = useSetClosePeriodStatus();
  const addTask = useAddCloseTask();
  const setTaskStatus = useSetCloseTaskStatus();
  const createPbc = useCreatePbcRequest();
  const acceptPbc = useAcceptPbcRequest();

  const [newPeriodName, setNewPeriodName] = useState("");
  const [createPeriodOpen, setCreatePeriodOpen] = useState(false);

  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [createTaskOpen, setCreateTaskOpen] = useState(false);

  const [newPbcTitle, setNewPbcTitle] = useState("");
  const [newPbcDetail, setNewPbcDetail] = useState("");
  const [createPbcOpen, setCreatePbcOpen] = useState(false);

  const handleCreatePeriod = () => {
    if (!orgId || !newPeriodName.trim()) return;
    createPeriod.mutate({ 
      orgId, 
      data: { period: newPeriodName } 
    }, {
      onSuccess: (newPeriod) => {
        toast({ title: "Period created" });
        setCreatePeriodOpen(false);
        setNewPeriodName("");
        setActivePeriodId(newPeriod.id);
        queryClient.invalidateQueries({ queryKey: getListClosePeriodsQueryKey(orgId) });
      }
    });
  };

  const handleCreateTask = () => {
    if (!orgId || !activePeriodId || !newTaskTitle.trim()) return;
    addTask.mutate({
      orgId,
      periodId: activePeriodId,
      data: { title: newTaskTitle }
    }, {
      onSuccess: () => {
        toast({ title: "Task added" });
        setCreateTaskOpen(false);
        setNewTaskTitle("");
        queryClient.invalidateQueries({ queryKey: getGetCloseStatusQueryKey(orgId, activePeriodId) });
      }
    });
  };

  const handleCreatePbc = () => {
    if (!orgId || !activePeriodId || !newPbcTitle.trim()) return;
    createPbc.mutate({
      orgId,
      periodId: activePeriodId,
      data: { title: newPbcTitle, detail: newPbcDetail }
    }, {
      onSuccess: () => {
        toast({ title: "PBC Request created" });
        setCreatePbcOpen(false);
        setNewPbcTitle("");
        setNewPbcDetail("");
        queryClient.invalidateQueries({ queryKey: getGetCloseStatusQueryKey(orgId, activePeriodId) });
      }
    });
  };

  const handleTaskStatus = (taskId: string, status: "pending" | "in_progress" | "done") => {
    if (!orgId) return;
    setTaskStatus.mutate({
      orgId,
      taskId,
      data: { status }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCloseStatusQueryKey(orgId, activePeriodId!) });
      }
    });
  };

  const handlePeriodStatus = (status: "open" | "in_progress" | "in_review" | "closed") => {
    if (!orgId || !activePeriodId) return;
    setPeriodStatus.mutate({
      orgId,
      periodId: activePeriodId,
      data: { status }
    }, {
      onSuccess: () => {
        toast({ title: `Status updated to ${status}` });
        queryClient.invalidateQueries({ queryKey: getListClosePeriodsQueryKey(orgId) });
        queryClient.invalidateQueries({ queryKey: getGetCloseStatusQueryKey(orgId, activePeriodId) });
      }
    });
  };

  const handleAcceptPbc = (requestId: string) => {
    if (!orgId) return;
    acceptPbc.mutate({ orgId, requestId }, {
      onSuccess: () => {
        toast({ title: "PBC Request accepted" });
        queryClient.invalidateQueries({ queryKey: getGetCloseStatusQueryKey(orgId, activePeriodId!) });
      }
    });
  };

  if (accessDenied) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-center space-y-6">
        <div className="bg-destructive/10 p-6 rounded-full">
          <AlertCircle className="w-12 h-12 text-destructive" />
        </div>
        <div>
          <h2 className="text-2xl font-serif font-semibold text-foreground mb-2">Access Denied</h2>
          <p className="text-muted-foreground">You do not have access to this client's books.</p>
        </div>
        <Button onClick={() => setLocation("/practice")} variant="outline">
          Back to Practice Dashboard
        </Button>
      </div>
    );
  }

  if (switchMutation.isPending || periodsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  const activePeriod = periods.find(p => p.id === activePeriodId);

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/practice")}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h1 className="text-3xl font-serif font-semibold tracking-tight text-primary">Close Management</h1>
          <p className="text-muted-foreground mt-1">Manage month-end close for this client.</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Left Sidebar: Periods */}
        <div className="w-full md:w-64 space-y-4 shrink-0">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">Periods</h3>
            <Dialog open={createPeriodOpen} onOpenChange={setCreatePeriodOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Plus className="w-4 h-4" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Close Period</DialogTitle>
                  <DialogDescription>Start a new month-end close cycle.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Period Name (e.g. Oct 2023)</Label>
                    <Input value={newPeriodName} onChange={e => setNewPeriodName(e.target.value)} placeholder="Oct 2023" />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCreatePeriodOpen(false)}>Cancel</Button>
                  <Button onClick={handleCreatePeriod} disabled={!newPeriodName.trim() || createPeriod.isPending}>
                    {createPeriod.isPending ? <Spinner className="mr-2" /> : null} Create
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {periods.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8 border rounded-md border-dashed">
              No periods found.
            </div>
          ) : (
            <div className="space-y-2">
              {periods.map(period => (
                <button
                  key={period.id}
                  onClick={() => setActivePeriodId(period.id)}
                  className={`w-full text-left px-4 py-3 rounded-md border transition-colors flex justify-between items-center ${
                    activePeriodId === period.id 
                      ? "bg-primary text-primary-foreground border-primary" 
                      : "bg-card border-border hover:bg-muted"
                  }`}
                >
                  <span className="font-medium">{period.period}</span>
                  {period.status === "closed" && <CheckCircle2 className={`w-4 h-4 ${activePeriodId === period.id ? "text-primary-foreground" : "text-green-600"}`} />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Main Content: Period Details */}
        <div className="flex-1">
          {!activePeriodId ? (
            <Card className="h-64 flex items-center justify-center border-dashed">
              <CardContent className="text-center text-muted-foreground py-0">
                Select a period or create a new one to manage the close.
              </CardContent>
            </Card>
          ) : statusLoading || !statusData ? (
             <Card className="h-64 flex items-center justify-center">
               <Spinner className="w-8 h-8 text-primary" />
             </Card>
          ) : (
            <div className="space-y-6">
              <Card>
                <CardHeader className="pb-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-2xl font-serif">{activePeriod?.period}</CardTitle>
                      <CardDescription>Status: {activePeriod?.status.replace('_', ' ')}</CardDescription>
                    </div>
                    <Select 
                      value={activePeriod?.status} 
                      onValueChange={(val: any) => handlePeriodStatus(val)}
                      disabled={setPeriodStatus.isPending}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="in_review">In Review</SelectItem>
                        <SelectItem value="closed">Closed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 mb-6 text-center">
                    <div className="bg-muted p-4 rounded-md">
                      <div className="text-2xl font-semibold mb-1">{statusData.tasks.total}</div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Total Tasks</div>
                    </div>
                    <div className="bg-muted p-4 rounded-md">
                      <div className="text-2xl font-semibold mb-1 text-green-600">{statusData.tasks.done}</div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Completed</div>
                    </div>
                    <div className="bg-muted p-4 rounded-md">
                      <div className="text-2xl font-semibold mb-1 text-amber-600">{statusData.pbc.open}</div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Pending PBCs</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Tasks */}
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
                  <div>
                    <CardTitle className="text-lg flex items-center">
                      <CheckSquare className="w-5 h-5 mr-2 text-primary" /> Checklist Tasks
                    </CardTitle>
                  </div>
                  <Dialog open={createTaskOpen} onOpenChange={setCreateTaskOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm"><Plus className="w-4 h-4 mr-1" /> Add Task</Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Add Close Task</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Task Title</Label>
                          <Input value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)} placeholder="e.g. Reconcile Chase Checking" />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setCreateTaskOpen(false)}>Cancel</Button>
                        <Button onClick={handleCreateTask} disabled={!newTaskTitle.trim() || addTask.isPending}>
                          {addTask.isPending ? <Spinner className="mr-2" /> : null} Add Task
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </CardHeader>
                <CardContent className="pt-4">
                  {statusData.tasks.items.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      No tasks added yet.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {statusData.tasks.items.map(task => (
                        <div key={task.id} className="flex items-center justify-between p-3 border rounded-md hover:bg-muted/30 transition-colors">
                          <div className="flex items-center gap-3">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className={`h-8 w-8 rounded-full ${
                                  task.status === 'done' ? 'text-green-600 bg-green-50 hover:bg-green-100 hover:text-green-700' :
                                  task.status === 'in_progress' ? 'text-amber-600 bg-amber-50 hover:bg-amber-100 hover:text-amber-700' :
                                  'text-gray-400 bg-gray-50 hover:bg-gray-100'
                                }`}>
                                  {task.status === 'done' ? <CheckCircle2 className="w-5 h-5" /> : 
                                   task.status === 'in_progress' ? <Play className="w-4 h-4" /> : 
                                   <Clock className="w-4 h-4" />}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent>
                                <DropdownMenuItem onClick={() => handleTaskStatus(task.id, "pending")}>Pending</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleTaskStatus(task.id, "in_progress")}>In Progress</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleTaskStatus(task.id, "done")}>Done</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <span className={`font-medium ${task.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>
                              {task.title}
                            </span>
                          </div>
                          <Badge variant="outline" className={
                             task.status === 'done' ? 'border-green-200 text-green-700' :
                             task.status === 'in_progress' ? 'border-amber-200 text-amber-700' :
                             'border-gray-200 text-gray-500'
                          }>
                            {task.status.replace('_', ' ')}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* PBC Requests */}
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
                  <div>
                    <CardTitle className="text-lg flex items-center">
                      <ListTodo className="w-5 h-5 mr-2 text-primary" /> Client Requests (PBC)
                    </CardTitle>
                    <CardDescription>Items needed from the client</CardDescription>
                  </div>
                  <Dialog open={createPbcOpen} onOpenChange={setCreatePbcOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" variant="outline"><Plus className="w-4 h-4 mr-1" /> New Request</Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Create PBC Request</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Title</Label>
                          <Input value={newPbcTitle} onChange={e => setNewPbcTitle(e.target.value)} placeholder="e.g. Bank Statement needed" />
                        </div>
                        <div className="space-y-2">
                          <Label>Details (Optional)</Label>
                          <Textarea value={newPbcDetail} onChange={e => setNewPbcDetail(e.target.value)} placeholder="Please provide the December statement for account ending in 1234." />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setCreatePbcOpen(false)}>Cancel</Button>
                        <Button onClick={handleCreatePbc} disabled={!newPbcTitle.trim() || createPbc.isPending}>
                          {createPbc.isPending ? <Spinner className="mr-2" /> : null} Request
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </CardHeader>
                <CardContent className="pt-4">
                  {statusData.pbc.items.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      No client requests for this period.
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {statusData.pbc.items.map(pbc => (
                        <div key={pbc.id} className="border rounded-md p-4">
                          <div className="flex items-start justify-between mb-2">
                            <div>
                              <h4 className="font-semibold">{pbc.title}</h4>
                              {pbc.detail && <p className="text-sm text-muted-foreground mt-1">{pbc.detail}</p>}
                            </div>
                            <Badge variant={pbc.status === 'accepted' ? 'default' : pbc.status === 'provided' ? 'secondary' : 'outline'}>
                              {pbc.status}
                            </Badge>
                          </div>
                          
                          {pbc.response && (
                            <div className="mt-4 bg-muted/50 p-3 rounded-md text-sm">
                              <span className="font-medium text-muted-foreground block mb-1">Client Response:</span>
                              {pbc.response}
                            </div>
                          )}

                          {pbc.status === 'provided' && (
                            <div className="mt-4 flex justify-end">
                              <Button size="sm" onClick={() => handleAcceptPbc(pbc.id)} disabled={acceptPbc.isPending}>
                                <Check className="w-4 h-4 mr-1" /> Accept Response
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
