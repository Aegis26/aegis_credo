import { useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  useGetSession, 
  useLogout,
  useListPracticeClients
} from "@workspace/api-client-react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { OrgSwitcher } from "@/components/org-switcher";
import { Button } from "@/components/ui/button";
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "@/components/ui/select";
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import {
  LayoutDashboard,
  Landmark,
  FileCheck,
  FileText,
  LineChart,
  Calculator,
  LogOut,
  Menu,
  UploadCloud,
  Receipt,
  PieChart,
  Users,
  UsersRound,
  Building,
  Briefcase,
  Network,
  ShieldCheck,
  SlidersHorizontal,
  Wallet
} from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { BrandWordmark } from "@/lib/brand";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: session } = useGetSession();
  const { orgId, setOrg, orgs, isLoading: isLoadingOrgs } = useCurrentOrg();
  const { data: practiceData } = useListPracticeClients();
  const logout = useLogout();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // If loading orgs, show spinner
  if (isLoadingOrgs) {
    return (
      <div className="flex items-center justify-center min-h-[100dvh] bg-background">
        <Spinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  const hasPractice = (practiceData?.clients?.length ?? 0) > 0;

  const navigation = [
    { name: "Overview", href: "/", icon: LayoutDashboard },
    { name: "Migrate", href: "/import", icon: UploadCloud },
    { name: "Bank", href: "/bank", icon: Landmark },
    { name: "Reconcile", href: "/reconcile", icon: FileCheck },
    { name: "Invoices", href: "/invoices", icon: FileText },
    { name: "Bills", href: "/bills", icon: Receipt },
    { name: "A/R Aging", href: "/aging", icon: PieChart },
    { name: "Payroll", href: "/payroll", icon: Users },
    { name: "Reports", href: "/reports", icon: LineChart },
    { name: "Taxes", href: "/taxes", icon: Calculator },
    { name: "Team", href: "/team", icon: UsersRound },
  ];

  const midMarketNavigation = [
    { name: "Entities", href: "/entities", icon: Network },
    { name: "Approvals", href: "/approvals", icon: ShieldCheck },
    { name: "Report Builder", href: "/report-builder", icon: SlidersHorizontal },
    { name: "Budgets", href: "/budgets", icon: Wallet },
  ];

  const practiceNavigation = [
    { name: "Dashboard", href: "/practice", icon: Briefcase },
    { name: "Batch Reports", href: "/practice/batch", icon: LineChart },
    { name: "Manage Clients", href: "/practice/setup", icon: Building },
  ];

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        window.location.href = "/login";
      }
    });
  };

  const NavLinks = () => (
    <>
      <div className="px-3 mb-2 mt-4 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
        Command Center
      </div>
      {navigation.map((item) => {
        const isActive = location === item.href;
        return (
          <Link 
            key={item.name} 
            href={item.href}
            onClick={() => setMobileMenuOpen(false)}
            className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all ${
              isActive 
                ? "bg-accent/50 text-primary border border-primary/20" 
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <item.icon className="w-4 h-4" />
            {item.name}
          </Link>
        );
      })}

      <div className="px-3 mb-2 mt-6 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
        Organization
      </div>
      {midMarketNavigation.map((item) => {
        const isActive = location === item.href;
        return (
          <Link
            key={item.name}
            href={item.href}
            onClick={() => setMobileMenuOpen(false)}
            className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all ${
              isActive
                ? "bg-accent/50 text-primary border border-primary/20"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <item.icon className="w-4 h-4" />
            {item.name}
          </Link>
        );
      })}

      {hasPractice && (
        <>
          <div className="px-3 mb-2 mt-6 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
            Practice Cockpit
          </div>
          {practiceNavigation.map((item) => {
            const isActive = location === item.href || (item.href !== "/practice" && location.startsWith(item.href));
            return (
              <Link 
                key={item.name} 
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all ${
                  isActive 
                    ? "bg-accent/50 text-primary border border-primary/20" 
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.name}
              </Link>
            );
          })}
        </>
      )}

      {!hasPractice && (
        <div className="mt-8 px-3">
          <Link href="/practice/setup">
            <div className="p-3 bg-card border border-border rounded-md text-sm hover:border-primary/50 cursor-pointer transition-colors group">
              <div className="flex items-center gap-2 font-medium text-foreground mb-1 group-hover:text-primary transition-colors">
                <ShieldCheck className="w-4 h-4" />
                Accountant Access
              </div>
              <div className="text-xs text-muted-foreground leading-tight">
                Setup your practice cockpit to manage multiple clients securely.
              </div>
            </div>
          </Link>
        </div>
      )}
    </>
  );

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background">
      {/* Sidebar for desktop */}
      <aside className="hidden md:flex flex-col w-64 border-r border-border bg-[#0A0A0A]">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <BrandWordmark />
        </div>
        
        {orgs.length > 0 && (
          <div className="p-4 border-b border-border">
            <OrgSwitcher />
          </div>
        )}

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          <NavLinks />
        </nav>

        <div className="p-4 border-t border-border">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="w-full justify-start gap-2 px-2 hover:bg-accent">
                <Avatar className="w-6 h-6 border border-border">
                  <AvatarFallback className="bg-card text-foreground text-xs font-medium">
                    {session?.user?.name?.charAt(0).toUpperCase() || session?.user?.email?.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 text-left truncate text-sm text-foreground">
                  {session?.user?.name || session?.user?.email}
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-card border-border">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none text-foreground">{session?.user?.name}</p>
                  <p className="text-xs leading-none text-muted-foreground">{session?.user?.email}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer">
                <LogOut className="w-4 h-4 mr-2" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="md:hidden flex items-center justify-between p-4 border-b border-border bg-[#0A0A0A]">
        <BrandWordmark />
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="hover:bg-accent text-foreground">
              <Menu className="w-5 h-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0 flex flex-col bg-[#0A0A0A] border-r border-border">
            <div className="p-4 border-b border-border">
              <div className="mb-4">
                <BrandWordmark />
              </div>
              {orgs.length > 0 && <OrgSwitcher />}
            </div>
            
            <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
              <NavLinks />
            </nav>

            <div className="p-4 border-t border-border">
              <div className="flex items-center gap-2 mb-4 px-2">
                <Avatar className="w-8 h-8 border border-border">
                  <AvatarFallback className="bg-card text-foreground text-sm font-medium">
                    {session?.user?.name?.charAt(0).toUpperCase() || session?.user?.email?.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 text-left truncate text-sm">
                  <p className="font-medium text-foreground">{session?.user?.name}</p>
                  <p className="text-xs text-muted-foreground">{session?.user?.email}</p>
                </div>
              </div>
              <Button variant="destructive" className="w-full justify-start bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground border border-transparent hover:border-destructive" onClick={handleLogout}>
                <LogOut className="w-4 h-4 mr-2" />
                Log out
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-background">
        <div className="max-w-6xl mx-auto p-4 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
