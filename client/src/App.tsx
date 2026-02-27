import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import { WalletProvider } from "@/lib/wallet";
import { GlobalErrorBoundary } from "@/components/error-boundary";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import OpenPayPage from "@/pages/open-pay";
import PayPage from "@/pages/pay";
import SuccessPage from "@/pages/success";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={LoginPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/dashboard" component={DashboardPage} />
      <Route path="/open/pay/:code" component={OpenPayPage} />
      <Route path="/pay/:code" component={PayPage} />
      <Route path="/success" component={SuccessPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <GlobalErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <WalletProvider>
              <Toaster />
              <Router />
            </WalletProvider>
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </GlobalErrorBoundary>
  );
}

export default App;
