import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SUPPORTED_NETWORKS } from "@/lib/metamask";
import { getTokensForNetwork, type TokenInfo } from "@shared/contracts";
import { isAllowedVideoUrl } from "@shared/video";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Coins, Copy, Check } from "lucide-react";

const createPlanSchema = z.object({
  planName: z.string().min(1, "Plan name is required"),
  networkChainId: z.string().min(1, "Network is required"),
  tokenAddress: z.string().min(1, "Token is required"),
  intervalAmount: z.string().min(1, "Amount is required").refine((val) => !isNaN(Number(val)) && Number(val) > 0, "Must be a positive number"),
  intervalValue: z.string().min(1, "Interval is required").refine((val) => !isNaN(Number(val)) && Number(val) > 0, "Must be a positive number"),
  intervalUnit: z.string().min(1, "Unit is required"),
  videoUrl: z
    .string()
    .optional()
    .refine((value) => !value || isAllowedVideoUrl(value), "Use an https YouTube/Vimeo URL or direct .mp4/.webm/.ogg file"),
});

type CreatePlanInput = z.infer<typeof createPlanSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  savedWalletAddress?: string | null;
}

export default function CreatePlanDialog({ open, onOpenChange, savedWalletAddress }: Props) {
  const { toast } = useToast();
  const [availableTokens, setAvailableTokens] = useState<TokenInfo[]>([]);
  const [copiedTokenAddress, setCopiedTokenAddress] = useState<string | null>(null);
  // Enforce per-user wallet setup: plans should use only a wallet saved for this account.
  const effectiveWallet = savedWalletAddress || null;

  const form = useForm<CreatePlanInput>({
    resolver: zodResolver(createPlanSchema),
    defaultValues: {
      planName: "",
      networkChainId: "",
      tokenAddress: "",
      intervalAmount: "",
      intervalValue: "1",
      intervalUnit: "months",
      videoUrl: "",
    },
  });

  const selectedNetwork = form.watch("networkChainId");

  useEffect(() => {
    if (selectedNetwork) {
      const tokens = getTokensForNetwork(selectedNetwork);
      setAvailableTokens(tokens);
      form.setValue("tokenAddress", "");
    } else {
      setAvailableTokens([]);
    }
  }, [selectedNetwork, form]);

  const mutation = useMutation({
    mutationFn: async (data: CreatePlanInput) => {
      const network = SUPPORTED_NETWORKS.find((n) => n.chainId === data.networkChainId);
      if (!network) throw new Error("Invalid network");

      const token = availableTokens.find((t) => t.address === data.tokenAddress);
      if (!token) throw new Error("Invalid token");

      const res = await apiRequest("POST", "/api/plans", {
        planName: data.planName,
        walletAddress: effectiveWallet!,
        networkId: network.chainId,
        networkName: network.name,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        intervalAmount: data.intervalAmount,
        intervalValue: parseInt(data.intervalValue),
        intervalUnit: data.intervalUnit,
        videoUrl: data.videoUrl || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      form.reset();
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast({ title: "Failed to create plan", description: e.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: CreatePlanInput) => {
    if (!effectiveWallet) {
      toast({ title: "No wallet available", description: "Connect Trust Wallet or MetaMask (or add a wallet in Settings)", variant: "destructive" });
      return;
    }
    mutation.mutate(data);
  };

  const copyTokenAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedTokenAddress(address);
      setTimeout(() => setCopiedTokenAddress((current) => (current === address ? null : current)), 1200);
      toast({ title: "Token address copied" });
    } catch {
      toast({ title: "Could not copy token address", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="w-5 h-5" />
            Create Auto-charge
          </DialogTitle>
          <DialogDescription>
            Set up a recurring ERC-20 token auto-charge. Users approve once and charges execute automatically.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pb-2">
            <FormField
              control={form.control}
              name="planName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Plan Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Monthly Access" data-testid="input-plan-name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-2">
              <label className="text-sm font-medium">Receiving Wallet</label>
              <div className="p-3 rounded-md bg-muted text-sm font-mono truncate">
                {effectiveWallet || "Not connected"}
              </div>
            </div>

            <FormField
              control={form.control}
              name="networkChainId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Network</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-network">
                        <SelectValue placeholder="Select a network" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">Mainnets</div>
                      {SUPPORTED_NETWORKS.filter((n) => n.type === "mainnet").map((net) => (
                        <SelectItem key={net.chainId} value={net.chainId} data-testid={`option-network-${net.chainId}`}>
                          {net.name} ({net.symbol})
                        </SelectItem>
                      ))}
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground mt-1">Testnets</div>
                      {SUPPORTED_NETWORKS.filter((n) => n.type === "testnet").map((net) => (
                        <SelectItem key={net.chainId} value={net.chainId} data-testid={`option-network-${net.chainId}`}>
                          {net.name} ({net.symbol})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="tokenAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Payment Token</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value} disabled={availableTokens.length === 0}>
                    <FormControl>
                      <SelectTrigger data-testid="select-token">
                        <SelectValue placeholder={availableTokens.length === 0 ? "Select a network first" : "Select token"} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {availableTokens.map((token) => (
                        <SelectItem key={token.address} value={token.address} data-testid={`option-token-${token.symbol}`}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{token.symbol}</span>
                            <span className="text-muted-foreground text-xs">{token.name}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {field.value && (
                    <div className="mt-1 rounded-md border bg-muted/40 p-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-mono break-all leading-5">{field.value}</p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs shrink-0"
                          onClick={() => copyTokenAddress(field.value)}
                          data-testid="button-copy-token-address"
                        >
                          {copiedTokenAddress === field.value ? (
                            <>
                              <Check className="w-3 h-3 mr-1" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3 mr-1" />
                              Copy
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="intervalAmount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount per interval ({availableTokens.find(t => t.address === form.getValues("tokenAddress"))?.symbol || "tokens"})</FormLabel>
                  <FormControl>
                    <Input type="number" step="any" placeholder="10.00" data-testid="input-interval-amount" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="intervalValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Every</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" placeholder="1" data-testid="input-interval-value" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="intervalUnit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Unit</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-interval-unit">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="sec">Seconds</SelectItem>
                        <SelectItem value="min">Minutes</SelectItem>
                        <SelectItem value="hrs">Hours</SelectItem>
                        <SelectItem value="days">Days</SelectItem>
                        <SelectItem value="months">Months</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="videoUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Video URL (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="https://youtube.com/watch?v=... or direct video URL" data-testid="input-video-url" {...field} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    Users will see this video after enabling auto-charge.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="p-3 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs text-blue-700 dark:text-blue-300">
              Users will approve a one-time ERC-20 token allowance. After approval, recurring charges execute automatically without wallet popups.
            </div>

            <Button type="submit" className="w-full" disabled={mutation.isPending} data-testid="button-submit-plan">
              <Plus className="w-4 h-4 mr-2" />
              {mutation.isPending ? "Creating..." : "Create Plan"}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
