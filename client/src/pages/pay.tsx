import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Plan, Subscription } from "@shared/schema";
import { ERC20_ABI, SUBSCRIPTION_CONTRACT_ABI, getContractForNetwork, normalizeChainId } from "@shared/contracts";
import { useWallet } from "@/lib/wallet";
import { isMobile, openInMetaMaskMobile, openInTrustWalletMobile, getChainName, type WalletBrand } from "@/lib/metamask";
import { Contract, parseUnits, formatUnits, Signature } from "ethers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaymentLoader } from "@/components/payment-loader";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Copy,
  Delete as DeleteIcon,
  Info,
  QrCode,
  Settings,
  Wallet,
  X,
} from "lucide-react";
import { SiEthereum } from "react-icons/si";

const TESTNET_CHAIN_IDS = ["0xaa36a7", "0x5"];

function isTestnet(chainId: string | number): boolean {
  const norm = normalizeChainId(chainId);
  return norm ? TESTNET_CHAIN_IDS.includes(norm.toLowerCase()) : false;
}

function extractServerJsonMessage(text: string): string | null {
  const m = String(text || "").match(/^\s*\d{3}\s*:\s*(\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // ignore
  }
  return null;
}

function getFriendlyError(error: any, tokenSymbol: string, networkName: string, chainId: string): string {
  let msg = error?.message || error?.toString() || "Unknown error";
  const serverMsg = extractServerJsonMessage(msg);
  if (serverMsg) msg = serverMsg;

  const lower = String(msg).toLowerCase();
  if (
    lower.includes("server_error") ||
    lower.includes("server error") ||
    (lower.includes("rpc") && (lower.includes("522") || lower.includes("timeout") || lower.includes("timed out") || lower.includes("gateway")))
  ) {
    const normChain = normalizeChainId(chainId);
    if (normChain?.toLowerCase() === "0xaa36a7") {
      return "Sepolia RPC is temporarily unavailable. Please try again in a minute.";
    }
    return `Network RPC is temporarily unavailable on ${networkName}. Please try again.`;
  }

  if (lower.includes("missing revert data") || msg.includes("CALL_EXCEPTION")) {
    if (isTestnet(chainId)) {
      return `Your wallet doesn't have any ${tokenSymbol} test tokens on ${networkName}. You need to get test tokens from a faucet before you can make a payment.`;
    }
    return `Transaction failed - likely insufficient ${tokenSymbol} balance. Make sure you have enough ${tokenSymbol} tokens in your wallet on ${networkName}.`;
  }
  if (
    lower.includes("insufficient funds") ||
    lower.includes("intrinsic transaction cost") ||
    lower.includes("gas required exceeds allowance") ||
    lower.includes("base fee exceeds gas limit")
  ) {
    return `Not enough native gas coin in your wallet for network fees on ${networkName}. Add a little more ETH and try again.`;
  }
  if (lower.includes("user rejected") || lower.includes("user denied")) {
    return "Transaction cancelled by user.";
  }
  if (lower.includes("nonce")) {
    return "Transaction nonce error. Try resetting your MetaMask account activity (Settings > Advanced > Clear activity tab data).";
  }
  return msg;
}

function shortAddress(addr: string): string {
  const a = addr || "";
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function toFiniteNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

type PayUiBrand = "trust" | "metamask";
type PayQuote = {
  tokenSymbol: string;
  networkId: string | null;
  usdRate: number | null;
  gasFeeToken: string | null;
  gasFeeUsd: number | null;
  asOf: string;
  stale: boolean;
};

function parseWalletHint(locationPath: string): PayUiBrand | null {
  const queryStart = locationPath.indexOf("?");
  if (queryStart < 0) return null;
  const value = new URLSearchParams(locationPath.slice(queryStart + 1)).get("wallet");
  if (value === "trust" || value === "metamask") return value;
  return null;
}

function resolvePayUiBrand(walletBrand: WalletBrand | null | undefined, hintedBrand: PayUiBrand | null): PayUiBrand {
  if (walletBrand === "trust" || walletBrand === "metamask") return walletBrand;
  return hintedBrand ?? "trust";
}

function withWalletHint(rawUrl: string, brand: PayUiBrand): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("wallet", brand);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function sanitizeAmountInput(raw: string, maxDecimals: number): string {
  let value = raw.replace(/[^0-9.]/g, "");
  if (!value) return "";

  if (value.startsWith(".")) {
    value = `0${value}`;
  }

  const firstDotIndex = value.indexOf(".");
  if (firstDotIndex >= 0) {
    const whole = value.slice(0, firstDotIndex + 1);
    const fraction = value
      .slice(firstDotIndex + 1)
      .replace(/\./g, "")
      .slice(0, Math.max(0, maxDecimals));
    value = `${whole}${fraction}`;
  }

  if (value !== "0" && !value.startsWith("0.")) {
    value = value.replace(/^0+/, "");
  }

  return value || "";
}

function isInsideWalletInAppBrowser(brand: PayUiBrand): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = (navigator.userAgent || "").toLowerCase();
  const eth = (window as any).ethereum;

  if (brand === "trust") {
    return (
      ua.includes("trustwallet") ||
      ua.includes("trust wallet") ||
      ua.includes("trust") ||
      (eth && (eth.isTrust || eth.isTrustWallet))
    );
  }
  if (brand === "metamask") {
    return ua.includes("metamask") || (eth && eth.isMetaMask);
  }
  return false;
}

export default function PayPage() {
  const params = useParams<{ code: string }>();
  const [locationPath] = useLocation();
  const { toast } = useToast();
  const wallet = useWallet();

  const [firstPaymentAmount, setFirstPaymentAmount] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    console.log("[PayPage] Mounted", { code: params.code, locationPath, wallet: wallet.address, chainId: wallet.chainId });
  }, []);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [step, setStep] = useState<"first-payment" | "processing">("first-payment");
  const [processingStage, setProcessingStage] = useState<1 | 2>(1);
  const [authFlow, setAuthFlow] = useState<"permit" | "approve">("permit");
  const [tokenBalance, setTokenBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [uiStage, setUiStage] = useState<"send" | "confirm">("send");

  const walletHint = useMemo(() => parseWalletHint(locationPath), [locationPath]);
  const uiBrand = useMemo(() => resolvePayUiBrand(wallet.walletBrand, walletHint), [wallet.walletBrand, walletHint]);
  const isMetaMaskUi = uiBrand === "metamask";

  const pageBgClass = isMetaMaskUi ? "bg-[#0f0f10]" : "bg-[#17191d]";
  const appGradientClass = isMetaMaskUi
    ? "bg-[radial-gradient(circle_at_top,rgba(246,133,27,0.10),rgba(255,255,255,0)_40%),linear-gradient(180deg,#151312_0%,#111112_46%,#0E0F10_100%)]"
    : "bg-[linear-gradient(180deg,#181a1f_0%,#16181c_52%,#15171b_100%)]";
  const headerIconClass = isMetaMaskUi ? "text-[#ddd2c5]" : "text-[#d8dce3]";
  const sectionLabelClass = isMetaMaskUi ? "text-[#b3a69a]" : "text-[#aeb2ba]";
  const fieldBorderClass = isMetaMaskUi ? "border-[#6a6057]" : "border-[#656a74]";
  const fieldBgClass = isMetaMaskUi ? "bg-[#181513]" : "bg-[#191b20]";
  const fieldTextClass = isMetaMaskUi ? "text-[#efe7dd]" : "text-[#eceff4]";
  const neutralChipClass = isMetaMaskUi ? "bg-[#dfd0bf] text-[#2e2318]" : "bg-[#cfd3da] text-[#1b1f28]";
  const accentTextClass = isMetaMaskUi ? "text-[#f89c3d]" : "text-[#4bf58c]";
  const networkPillBgClass = isMetaMaskUi ? "bg-[#27231f]" : "bg-[#23262d]";
  const networkIconClass = isMetaMaskUi ? "bg-[#f2e8dd] text-[#3a2a1a]" : "bg-[#eceef1] text-[#1a1d22]";
  const panelBgClass = isMetaMaskUi ? "bg-[#221f1b]" : "bg-[#23262c]";
  const primaryButtonClass = isMetaMaskUi
    ? "bg-[#f6851b] text-[#24160a] hover:bg-[#e2761b]"
    : "bg-[#4bf58c] text-[#10171d] hover:bg-[#43e381]";
  const hintBorderClass = isMetaMaskUi ? "border-[#f89c3d]/40" : "border-[#2e6f4e]";
  const hintBgClass = isMetaMaskUi ? "bg-[#2b1d11]" : "bg-[#1a2f24]";
  const hintTitleClass = isMetaMaskUi ? "text-[#ffd2a4]" : "text-[#c7f6dd]";
  const hintBodyClass = isMetaMaskUi ? "text-[#ffc78e]" : "text-[#b6edcf]";
  const hintButtonClass = isMetaMaskUi ? "border-[#f89c3d]/45 text-[#f89c3d]" : "border-[#4bf58c]/40 text-[#4bf58c]";
  const valueStrongClass = isMetaMaskUi ? "text-[#f1e8de]" : "text-[#ecf0f4]";
  const valueMutedClass = isMetaMaskUi ? "text-[#b8aea4]" : "text-[#aab0b9]";
  const totalLabelClass = isMetaMaskUi ? "text-[#bbb0a6]" : "text-[#afb4bd]";
  const flexGasTextGradientClass = isMetaMaskUi
    ? "bg-[linear-gradient(90deg,#ffd7a6_0%,#f89c3d_48%,#ffd082_100%)]"
    : "bg-[linear-gradient(90deg,#66c8ff_0%,#b091ff_45%,#ffd98b_100%)]";

  const { data: plan, isLoading, error } = useQuery<Plan>({
    queryKey: ["/api/plans/code", params.code],
  });

  const quoteTokenSymbol = (plan?.tokenSymbol || "ETH").toUpperCase();
  const quoteNetworkId = plan?.networkId || "";
  const { data: quote } = useQuery<PayQuote | null>({
    queryKey: ["/api/quote", quoteTokenSymbol, quoteNetworkId],
    enabled: !!plan,
    refetchInterval: 60_000,
    queryFn: async () => {
      const res = await fetch(
        `/api/quote?tokenSymbol=${encodeURIComponent(quoteTokenSymbol)}&networkId=${encodeURIComponent(quoteNetworkId)}`
      );
      if (!res.ok) return null;
      return res.json();
    },
  });

  const onCorrectNetwork = useMemo(() => {
    const normWallet = normalizeChainId(wallet.chainId);
    const normPlan = normalizeChainId(plan?.networkId);
    return !normWallet || (normPlan && normWallet.toLowerCase() === normPlan.toLowerCase());
  }, [wallet.chainId, plan?.networkId]);

  const openWalletAppAfterActivation = useCallback(() => {
    if (typeof window === "undefined") return;

    const homeUrl = withWalletHint(`${window.location.origin}/`, uiBrand);
    const insideInApp = isInsideWalletInAppBrowser(uiBrand);

    // If using Trust Wallet, try to return to the native wallet home using trust:// scheme
    if (uiBrand === "trust") {
      window.location.href = "trust://";
      // If we are already inside the in-app browser, trust:// might not trigger a close,
      // so we also try a fallback redirect to our app home for safety after a delay.
      if (insideInApp) {
        setTimeout(() => {
          if (typeof document !== "undefined" && document.visibilityState === "visible") {
            window.location.replace(homeUrl);
          }
        }, 1500);
        return;
      }
    }

    // Existing logic for MetaMask or generic redirection
    if (insideInApp) {
      window.location.replace(homeUrl);
      return;
    }

    // Best-effort close for popup/tab contexts.
    try {
      window.close();
    } catch {
      // ignore
    }

    if (isMobile()) {
      if (uiBrand === "metamask") {
        openInMetaMaskMobile(homeUrl);
      } else {
        openInTrustWalletMobile(homeUrl);
      }
    }

    // Fallback when app switch is blocked/unavailable.
    // Only run fallback if the page is still visible (app switch did not happen).
    setTimeout(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      window.location.replace(homeUrl);
    }, isMobile() ? 2600 : 700);
  }, [uiBrand]);

  useEffect(() => {
    if (plan && wallet.address) {
      console.log("[PayPage] Checking subscription status", { planId: plan.id, address: wallet.address });
      fetch(`/api/subscriptions/check/${plan.id}/${wallet.address}`)
        .then((r) => r.json())
        .then((data) => {
          if (data && data.id) {
            setSubscription(data);
            if (data.isActive && data.onChainSubscriptionId) {
              openWalletAppAfterActivation();
              return;
            }
          }
        })
        .catch(() => { });
    }
  }, [plan, wallet.address, openWalletAppAfterActivation]);

  useEffect(() => {
    if (!plan) return;
    if (firstPaymentAmount !== "") return;
    if (isMetaMaskUi) {
      setFirstPaymentAmount("");
      return;
    }
    setFirstPaymentAmount(plan.recurringAmount || plan.intervalAmount);
  }, [plan?.id, plan?.recurringAmount, plan?.intervalAmount, firstPaymentAmount, isMetaMaskUi]);

  useEffect(() => {
    setUiStage("send");
  }, [plan?.id]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!plan?.tokenAddress || !wallet.address || !wallet.eip1193Provider) {
        setTokenBalance(null);
        return;
      }
      const normWalletChain = normalizeChainId(wallet.chainId);
      const normPlanChain = normalizeChainId(plan.networkId);

      if (!normWalletChain || normWalletChain.toLowerCase() !== normPlanChain?.toLowerCase()) {
        setTokenBalance(null);
        return;
      }

      setBalanceLoading(true);
      try {
        const provider = wallet.getEthersProvider();
        const tokenContract = new Contract(plan.tokenAddress, ERC20_ABI, provider);
        const balWei = await tokenContract.balanceOf(wallet.address);
        if (cancelled) return;
        const decimals = plan.tokenDecimals || 18;
        setTokenBalance(formatUnits(balWei, decimals));
      } catch {
        if (!cancelled) setTokenBalance(null);
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [plan?.tokenAddress, plan?.tokenDecimals, plan?.networkId, wallet.address, wallet.chainId, wallet.eip1193Provider, wallet]);

  const getIntervalSeconds = (value: number, unit: string): number => {
    const multipliers: Record<string, number> = {
      sec: 1,
      min: 60,
      hrs: 3600,
      days: 86400,
      months: 2592000,
    };
    return value * (multipliers[unit] || 1);
  };

  const handleNext = () => {
    if (!plan || !plan.tokenAddress) return;
    const requestedAmount = firstPaymentAmount || (isMetaMaskUi ? "" : plan.recurringAmount || plan.intervalAmount);
    if (!requestedAmount || Number.isNaN(Number(requestedAmount)) || Number(requestedAmount) <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    setUiStage("confirm");
  };

  const copyDestinationAddress = async () => {
    if (!plan?.walletAddress) return;
    try {
      await navigator.clipboard.writeText(plan.walletAddress);
      toast({ title: "Address copied" });
    } catch {
      toast({ title: "Could not copy address", variant: "destructive" });
    }
  };

  const maxDecimals = plan?.tokenDecimals || 18;
  const hasTypedAmount = Number(firstPaymentAmount) > 0;

  const handleMetaMaskKeypad = (value: string) => {
    setFirstPaymentAmount((current) => {
      if (value === "backspace") {
        return current.length > 0 ? current.slice(0, -1) : "";
      }

      if (value === ".") {
        if (current.includes(".")) return current;
        return current.length === 0 ? "0." : `${current}.`;
      }

      if (!/^\d$/.test(value)) {
        return current;
      }

      const next = current === "0" ? value : `${current}${value}`;
      return sanitizeAmountInput(next, maxDecimals);
    });
  };

  const setPercentAmount = (percent: number) => {
    const numericBalance = Number.parseFloat(tokenBalance || "");
    if (!Number.isFinite(numericBalance) || numericBalance <= 0) {
      setFirstPaymentAmount("");
      return;
    }
    const next = ((numericBalance * percent) / 100).toFixed(Math.min(6, maxDecimals));
    setFirstPaymentAmount(sanitizeAmountInput(next, maxDecimals));
  };

  const setMaxAmount = () => {
    if (tokenBalance && Number.parseFloat(tokenBalance) > 0) {
      setFirstPaymentAmount(sanitizeAmountInput(tokenBalance, maxDecimals));
      return;
    }
    setFirstPaymentAmount("");
  };

  const handleOneClickPayment = async () => {
    if (!plan || !plan.tokenAddress) return;
    const requestedAmount = firstPaymentAmount || (isMetaMaskUi ? "" : plan.recurringAmount || plan.intervalAmount);
    if (!requestedAmount || isNaN(Number(requestedAmount)) || Number(requestedAmount) <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }

    // Prefer the registry contract (shared/contracts.ts). Plans created before a redeploy may have a stale stored address.
    const contractAddr = getContractForNetwork(plan.networkId) || plan.contractAddress;
    if (!contractAddr) {
      toast({
        title: "Contract not deployed",
        description: "Payment contract not available on this network yet.",
        variant: "destructive",
      });
      return;
    }

    setIsProcessing(true);
    setStep("processing");
    setProcessingStage(1);
    setAuthFlow("permit");

    try {
      console.log("[PayPage] Starting payment process", { requestedAmount, uiBrand });
      let payer = wallet.address;
      if (!payer) {
        console.log("[PayPage] Connecting wallet...");
        const connected = await wallet.connect();
        payer = connected.address;
      }

      console.log("[PayPage] Ensuring correct chain", { target: plan.networkId });
      await wallet.ensureChain(plan.networkId, plan.networkName);

      const provider = wallet.getEthersProvider();
      const signer = await provider.getSigner();
      payer = await signer.getAddress();
      const payerLc = payer.toLowerCase();

      // Re-check subscription status after connect to avoid accidental double-charging.
      let currentSub: Subscription | null = subscription;
      try {
        const r = await fetch(`/api/subscriptions/check/${plan.id}/${payerLc}`);
        if (r.ok) {
          const data = await r.json();
          if (data && data.id) {
            currentSub = data;
            setSubscription(data);
          }
        }
      } catch { }

      if (currentSub?.isActive && currentSub?.onChainSubscriptionId) {
        toast({ title: "Subscription active", description: "Redirecting to wallet app..." });
        openWalletAppAfterActivation();
        return;
      }

      const isResumeActivation = !!(currentSub?.isActive && !currentSub?.onChainSubscriptionId);
      const amount = isResumeActivation ? currentSub!.firstPaymentAmount : requestedAmount;
      if (isResumeActivation && firstPaymentAmount !== currentSub!.firstPaymentAmount) {
        setFirstPaymentAmount(currentSub!.firstPaymentAmount);
      }

      const tokenContract = new Contract(plan.tokenAddress, ERC20_ABI, signer);
      const decimals = plan.tokenDecimals || 18;
      const initialWei = parseUnits(amount, decimals);
      // Recurring amount is defined by the plan (not the user's one-time payment).
      const recurringAmount = plan.recurringAmount || plan.intervalAmount;
      const recurringWei = parseUnits(recurringAmount, decimals);

      if (!isResumeActivation) {
        let tokenBalanceWei;
        try {
          tokenBalanceWei = await tokenContract.balanceOf(payer);
        } catch (balErr: any) {
          const friendly = getFriendlyError(balErr, plan.tokenSymbol || "tokens", plan.networkName, plan.networkId);
          toast({ title: "Payment failed", description: friendly, variant: "destructive" });
          setStep("first-payment");
          setIsProcessing(false);
          return;
        }

        if (tokenBalanceWei < initialWei) {
          const currentBalance = formatUnits(tokenBalanceWei, decimals);
          const desc = isTestnet(plan.networkId)
            ? `You have ${currentBalance} ${plan.tokenSymbol || "tokens"} but need ${amount}. Get free test tokens from a faucet to continue.`
            : `You have ${currentBalance} ${plan.tokenSymbol || "tokens"} but need ${amount}.`;
          toast({ title: "Insufficient token balance", description: desc, variant: "destructive" });
          setStep("first-payment");
          setIsProcessing(false);
          return;
        }
      }

      const subContract = new Contract(contractAddr, SUBSCRIPTION_CONTRACT_ABI, signer);
      const intervalSeconds = getIntervalSeconds(plan.intervalValue, plan.intervalUnit);

      const approvalPeriods = BigInt(12);
      const permitValue = recurringWei * approvalPeriods;
      const permitDeadline = Math.floor(Date.now() / 1000) + 60 * 30; // 30 min

      let approvalHash: string | null = null;
      let permitSig: { v: number; r: string; s: string } | null = null;

      // Step 1: Try permit signature (preferred). If unsupported, fallback to ERC-20 approve.
      try {
        const [tokenName, tokenVersion, nonce] = await Promise.all([
          tokenContract.name() as Promise<string>,
          tokenContract.version().catch(() => "1") as Promise<string>,
          tokenContract.nonces(payer) as Promise<bigint>,
        ]);

        const domain = {
          name: tokenName,
          version: tokenVersion,
          chainId: Number.parseInt(plan.networkId, 16),
          verifyingContract: plan.tokenAddress,
        };

        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };

        const message = {
          owner: payer,
          spender: contractAddr,
          value: permitValue,
          nonce,
          deadline: BigInt(permitDeadline),
        };

        const signature = await signer.signTypedData(domain, types as any, message as any);
        const parsed = Signature.from(signature);
        permitSig = { v: parsed.v, r: parsed.r, s: parsed.s };
        setAuthFlow("permit");
      } catch (permitErr: any) {
        const msg = permitErr?.message || permitErr?.toString?.() || "";
        const rejected = msg.includes("user rejected") || msg.includes("User denied") || msg.includes("rejected");
        if (rejected) throw permitErr;

        // Fallback: approval tx
        setAuthFlow("approve");
        const txApprove = await tokenContract.approve(contractAddr, permitValue);
        const receiptApprove = await txApprove.wait();
        approvalHash = receiptApprove.hash;
      }

      setProcessingStage(2);

      let receipt;
      const activationInitialWei = isResumeActivation ? BigInt(0) : initialWei;

      if (permitSig) {
        try {
          const tx = await subContract.activateWithPermit(
            plan.walletAddress,
            plan.tokenAddress,
            activationInitialWei,
            recurringWei,
            intervalSeconds,
            permitValue,
            permitDeadline,
            permitSig.v,
            permitSig.r,
            permitSig.s
          );
          receipt = await tx.wait();
        } catch (permitActivateErr: any) {
          const msg = permitActivateErr?.message || permitActivateErr?.toString?.() || "";
          const rejected = msg.includes("user rejected") || msg.includes("User denied") || msg.includes("rejected");
          if (rejected) throw permitActivateErr;

          // Some tokens don't support EIP-2612 permit (or have incompatible domain data).
          // Fallback to approve + activate without requiring the user to restart the flow.
          setAuthFlow("approve");
          setProcessingStage(1);
          const txApprove = await tokenContract.approve(contractAddr, permitValue);
          const receiptApprove = await txApprove.wait();
          approvalHash = receiptApprove.hash;

          setProcessingStage(2);
          const tx = await subContract.activate(
            plan.walletAddress,
            plan.tokenAddress,
            activationInitialWei,
            recurringWei,
            intervalSeconds
          );
          receipt = await tx.wait();
        }
      } else {
        const tx = await subContract.activate(
          plan.walletAddress,
          plan.tokenAddress,
          activationInitialWei,
          recurringWei,
          intervalSeconds
        );
        receipt = await tx.wait();
      }

      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = subContract.interface.parseLog(log);
          return parsed?.name === "SubscriptionCreated";
        } catch { return false; }
      });
      let onChainId = "";
      if (event) {
        const parsed = subContract.interface.parseLog(event);
        onChainId = parsed?.args[0]?.toString() || "";
      }

      if (!onChainId) {
        throw new Error("Activation succeeded but could not read the on-chain subscription id.");
      }

      if (isResumeActivation && currentSub) {
        const updated = await apiRequest("PATCH", `/api/subscriptions/${currentSub.id}/approval`, {
          approvalTxHash: approvalHash || receipt.hash,
          approvedAmount: permitValue.toString(),
          onChainSubscriptionId: onChainId,
        }).then((r) => r.json());
        setSubscription(updated);
        openWalletAppAfterActivation();
        return;
      }

      // New or reactivated subscription: store everything from the activation tx in one record.
      const res = await apiRequest("POST", "/api/subscriptions", {
        planId: plan.id,
        payerAddress: payerLc,
        firstPaymentAmount: amount,
        firstPaymentTxHash: receipt.hash,
        approvalTxHash: approvalHash || receipt.hash,
        approvedAmount: permitValue.toString(),
        onChainSubscriptionId: onChainId,
      });
      const payload = await res.json();
      const created = payload?.subscription ?? payload;
      setSubscription(created);
      openWalletAppAfterActivation();
    } catch (e: any) {
      const friendly = getFriendlyError(e, plan.tokenSymbol || "tokens", plan.networkName, plan.networkId);
      const stageLabels = { 1: authFlow === "permit" ? "Permit failed" : "Approval failed", 2: "Activation failed" };
      toast({ title: stageLabels[processingStage], description: friendly, variant: "destructive" });
      setStep("first-payment");
    } finally {
      setIsProcessing(false);
    }
  };

  if (isLoading) {
    return (
      <div className={`min-h-[100dvh] ${pageBgClass} text-[#d8dbe1] flex justify-center`}>
        <div className="w-full max-w-[430px] min-h-[100dvh] flex flex-col items-center justify-center gap-4 px-6">
          <PaymentLoader />
        </div>
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div className={`min-h-[100dvh] ${pageBgClass} text-[#f0f2f5] flex justify-center`}>
        <div className="w-full max-w-[430px] min-h-[100dvh] px-6 py-7">
          <button
            type="button"
            onClick={() => window.history.back()}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className={`mt-16 rounded-[20px] border ${fieldBorderClass} ${fieldBgClass} p-6 text-center`}>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-400">
              <AlertCircle className="h-6 w-6" />
            </div>
            <h3 className="text-xl font-semibold">Link not found</h3>
            <p className={`mt-2 text-sm ${valueMutedClass}`}>This payment link does not exist or has been removed.</p>
          </div>
        </div>
      </div>
    );
  }

  const recurringDisplayAmount = plan?.recurringAmount || plan?.intervalAmount;
  const tokenSymbol = plan?.tokenSymbol || "ETH";
  const amountPreview = firstPaymentAmount || (isMetaMaskUi ? "0" : recurringDisplayAmount);
  const hasInjectedWallet =
    typeof window !== "undefined" && typeof (window as any).ethereum !== "undefined";
  const showOpenInWalletHint = !hasInjectedWallet && isMobile();
  const hasUsdQuote = quote?.usdRate !== null && quote?.usdRate !== undefined && Number.isFinite(quote.usdRate);
  const amountUsd = hasUsdQuote ? toFiniteNumber(amountPreview) * Number(quote?.usdRate) : null;
  const networkFeeUsd = quote?.gasFeeUsd !== null && quote?.gasFeeUsd !== undefined && Number.isFinite(quote.gasFeeUsd)
    ? Number(quote.gasFeeUsd)
    : null;
  const networkFeeToken = quote?.gasFeeToken || "--";
  const totalUsd = amountUsd !== null && networkFeeUsd !== null ? amountUsd + networkFeeUsd : null;
  const amountUsdLabel = amountUsd !== null ? formatUsd(amountUsd) : "--";
  const networkFeeUsdLabel = networkFeeUsd !== null ? formatUsd(networkFeeUsd) : "--";
  const totalUsdLabel = totalUsd !== null ? formatUsd(totalUsd) : "--";
  const balanceAvailableLabel = tokenBalance && Number.parseFloat(tokenBalance) >= 0
    ? `${Number.parseFloat(tokenBalance).toFixed(5)} ${tokenSymbol} available`
    : balanceLoading
      ? "Loading balance..."
      : `0 ${tokenSymbol} available`;
  const metaMaskFontClass = "[font-family:'SF_Pro_Text','SF_Pro_Display',-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]";
  const trustWalletFontClass = "[font-family:'SF_Pro_Text','SF_Pro_Display',-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]";
  const destinationAddressDisplay = `:${plan.walletAddress.replace(/^0x/i, "").slice(-16)}`;

  if (isMetaMaskUi && uiStage === "send") {
    return (
      <div className={`min-h-[100dvh] bg-[#ececf2] text-[#090d17] flex justify-center ${metaMaskFontClass}`}>
        <div className="relative flex min-h-[100dvh] w-full max-w-[430px] flex-col overflow-x-hidden px-3 pb-3 pt-3 sm:px-4 sm:pb-4 sm:pt-4">
          <header className="relative flex items-center justify-center py-1">
            <button
              type="button"
              onClick={() => window.history.back()}
              className="absolute left-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-full text-[#0c111a] hover:bg-black/5"
              data-testid="button-pay-back"
            >
              <ArrowLeft className="h-8 w-8" />
            </button>
            <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Send</h1>
            <button
              type="button"
              onClick={() => window.history.back()}
              className="absolute right-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-full text-[#0c111a] hover:bg-black/5"
            >
              <X className="h-8 w-8" />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col justify-between">
            <div className="px-1 pt-8 text-center sm:pt-12 md:pt-20">
              <div className="flex items-end justify-center gap-2">
                <span className="max-w-[250px] truncate text-[clamp(3.1rem,11vw,5.2rem)] font-semibold leading-none tracking-[-0.03em] text-[#8790a5]">
                  {amountPreview}
                </span>
                <span className="mb-2 text-[clamp(2.6rem,8.4vw,4.2rem)] font-semibold leading-none tracking-[-0.03em] text-[#aeb5c6]">{tokenSymbol}</span>
              </div>
              <div className="mt-6 inline-flex items-center gap-1 rounded-full bg-[#e3e5ee] px-4 py-1 text-[18px] font-medium text-[#5f677b]">
                <span>{amountUsdLabel}</span>
                <ArrowUpDown className="h-4 w-4" />
              </div>
              <p className="mt-5 text-[clamp(1.75rem,4.9vw,2.05rem)] font-medium text-[#6e7689]">{balanceAvailableLabel}</p>

              {!wallet.address && showOpenInWalletHint && (
                <div className="mx-auto mt-8 max-w-[380px] rounded-2xl border border-[#d5d9e2] bg-[#f6f7fb] p-3 text-left">
                  <p className="text-base text-[#4f586d]">Open this link in MetaMask to continue.</p>
                  <button
                    type="button"
                    className="mt-2 inline-flex h-10 items-center justify-center rounded-full border border-[#c6ccdb] px-4 text-base font-semibold text-[#111723]"
                    onClick={() => openInMetaMaskMobile(withWalletHint(window.location.href, "metamask"))}
                    data-testid="button-pay-open-metamask"
                  >
                    <Wallet className="mr-2 h-4 w-4" />
                    Open in MetaMask
                  </button>
                </div>
              )}
            </div>

            <div className="rounded-t-[30px] bg-[#e7eaf2] px-3 pb-3 pt-3 shadow-[0_-1px_0_rgba(5,10,20,0.03)]">
              {hasTypedAmount && (
                <button
                  type="button"
                  className="mb-3 h-14 w-full rounded-[18px] bg-[#ffffff] text-[30px] font-semibold leading-none text-[#0e121b] shadow-[0_1px_0_rgba(7,12,24,0.08)] sm:h-16 sm:text-[40px]"
                  onClick={handleNext}
                  disabled={isProcessing}
                  data-testid="button-pay-next"
                >
                  Continue
                </button>
              )}

              <div className="grid grid-cols-4 gap-2.5">
                <button type="button" onClick={() => setPercentAmount(25)} className="h-12 rounded-[16px] bg-[#dce0ea] text-[16px] font-semibold text-[#0d111a] sm:h-14 sm:text-[18px]">25%</button>
                <button type="button" onClick={() => setPercentAmount(50)} className="h-12 rounded-[16px] bg-[#dce0ea] text-[16px] font-semibold text-[#0d111a] sm:h-14 sm:text-[18px]">50%</button>
                <button type="button" onClick={() => setPercentAmount(75)} className="h-12 rounded-[16px] bg-[#dce0ea] text-[16px] font-semibold text-[#0d111a] sm:h-14 sm:text-[18px]">75%</button>
                <button type="button" onClick={setMaxAmount} className="h-12 rounded-[16px] bg-[#dce0ea] text-[16px] font-semibold text-[#0d111a] sm:h-14 sm:text-[18px]">Max</button>
              </div>

              <div className="mt-2.5 grid grid-cols-3 gap-2.5">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "backspace"].map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleMetaMaskKeypad(key)}
                    className="flex h-16 items-center justify-center rounded-[16px] bg-[#dce0ea] text-[42px] font-semibold leading-none text-[#0d111a] sm:h-20 sm:text-[56px]"
                    data-testid={key === "backspace" ? "button-pay-keypad-backspace" : `button-pay-keypad-${key}`}
                  >
                    {key === "backspace" ? <DeleteIcon className="h-8 w-8 text-[#0d111a] sm:h-10 sm:w-10" /> : key}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {step === "processing" && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-transparent px-6 text-center pointer-events-none">
              <div>
                <PaymentLoader className="mx-auto" />
                <p className="mt-4 text-lg font-semibold text-[#101521]">
                  {processingStage === 1 && (authFlow === "permit" ? "Waiting for signature" : "Approving token")}
                  {processingStage === 2 && "Activating subscription"}
                </p>
                <p className="mt-2 text-sm text-[#6c7487]">
                  {processingStage === 1
                    ? authFlow === "permit"
                      ? "Sign in your wallet to continue."
                      : "Approve token spending in your wallet."
                    : "Confirm transaction in your wallet."}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isMetaMaskUi && uiStage === "confirm") {
    return (
      <div className={`min-h-[100dvh] bg-[#ececf2] text-[#090d17] flex justify-center ${metaMaskFontClass}`}>
        <div className="relative flex min-h-[100dvh] w-full max-w-[430px] flex-col overflow-y-auto px-3 pb-4 pt-3 sm:px-4 sm:pb-6 sm:pt-4">
          <header className="relative flex items-center justify-center py-1">
            <button
              type="button"
              onClick={() => setUiStage("send")}
              className="absolute left-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-full text-[#0c111a] hover:bg-black/5"
              data-testid="button-pay-close-confirm"
            >
              <ArrowLeft className="h-8 w-8" />
            </button>
            <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Review</h1>
            <div className="absolute right-0 top-1 h-10 w-10" />
          </header>

          <div className="mt-5 flex flex-col items-center text-center">
            <div className="relative">
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-[#f7f8fb] text-[38px] font-medium text-[#111723]">
                {tokenSymbol.slice(0, 1)}
              </div>
              <div className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#cbb0ee] text-sm font-semibold text-[#241838]">
                {tokenSymbol.slice(0, 1).toLowerCase()}
              </div>
            </div>
            <div className="mt-4 text-[clamp(2.3rem,9vw,4.1rem)] font-semibold leading-none tracking-[-0.03em] text-[#0b101a]">
              {amountPreview} {tokenSymbol}
            </div>
            <div className="mt-1 text-[clamp(1.95rem,5.6vw,2.35rem)] font-medium text-[#6e768a]">{amountUsdLabel}</div>
          </div>

          <div className="mt-5 space-y-3">
            <div className="rounded-[20px] border border-[#dfe3ec] bg-[#fbfcff] px-4 py-4 shadow-[0_1px_0_rgba(8,12,24,0.04)]">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-[#4b0c89] text-[20px] font-semibold text-white">
                      M
                    </div>
                    <div className="min-w-0 text-left">
                      <div className="truncate text-[22px] font-semibold text-[#101522]">{wallet.address ? shortAddress(wallet.address) : "Wallet"}</div>
                      <div className="text-[16px] text-[#6f7789]">Wallet 2</div>
                    </div>
                  </div>
                </div>
                <ChevronRight className="h-7 w-7 text-[#7a8398]" />
                <div className="min-w-0">
                  <div className="flex items-center justify-end gap-3">
                    <div className="min-w-0 text-right">
                      <div className="truncate text-[22px] font-semibold text-[#101522]">{shortAddress(plan.walletAddress)}</div>
                      <div className="text-[16px] text-[#6f7789]">Wallet 1</div>
                    </div>
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-[#d4f28f] text-[20px] font-semibold text-[#486300]">
                      S
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-[20px] border border-[#dfe3ec] bg-[#fbfcff] px-4 py-4 shadow-[0_1px_0_rgba(8,12,24,0.04)]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[22px] text-[#6f7789]">Network</span>
                <span className="inline-flex items-center gap-2 text-[22px] font-semibold text-[#0d131f]">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] bg-[#ceb3ee] text-xs font-semibold text-[#241838]">
                    s
                  </span>
                  {plan.networkName}
                </span>
              </div>
            </div>

            <div className="rounded-[20px] border border-[#dfe3ec] bg-[#fbfcff] px-4 py-4 shadow-[0_1px_0_rgba(8,12,24,0.04)]">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[22px] text-[#6f7789]">
                  <span>Network fee</span>
                  <Info className="h-5 w-5" />
                </div>
                <div className="inline-flex h-9 min-w-[136px] items-center justify-center rounded-xl bg-[#d5d9e2] px-3 text-[18px] font-semibold text-[#50586c]">
                  {networkFeeToken === "--" ? "--" : `${networkFeeToken} ${tokenSymbol}`}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[22px] text-[#6f7789]">Speed</span>
                <span className="text-[22px] text-[#1a202e]">Market ~ 12 sec</span>
              </div>
            </div>

            <button type="button" className="flex w-full items-center justify-between rounded-[20px] border border-[#dfe3ec] bg-[#fbfcff] px-4 py-4 text-left shadow-[0_1px_0_rgba(8,12,24,0.04)]">
              <span className="text-[22px] text-[#6f7789]">Advanced details</span>
              <ChevronRight className="h-7 w-7 text-[#7a8398]" />
            </button>
          </div>

          <div className="mt-auto pt-8">
            {wallet.address && !onCorrectNetwork && (
              <p className="mb-3 text-sm text-amber-700">Switch your wallet network to {plan.networkName} before confirming.</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className="h-16 rounded-[18px] bg-[#e2e5ee] text-2xl font-semibold text-[#0d111a]"
                onClick={() => setUiStage("send")}
              >
                Cancel
              </button>
              <button
                type="button"
                className="h-16 rounded-[18px] bg-[#070b14] text-2xl font-semibold text-[#f4f6fc] disabled:opacity-60"
                onClick={handleOneClickPayment}
                disabled={isProcessing}
                data-testid="button-pay-subscribe"
              >
                Confirm
              </button>
            </div>
          </div>

          {step === "processing" && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-transparent px-6 text-center pointer-events-none">
              <div>
                <PaymentLoader className="mx-auto" />
                <p className="mt-4 text-lg font-semibold text-[#101521]">
                  {processingStage === 1 && (authFlow === "permit" ? "Waiting for signature" : "Approving token")}
                  {processingStage === 2 && "Activating subscription"}
                </p>
                <p className="mt-2 text-sm text-[#6c7487]">
                  {processingStage === 1
                    ? authFlow === "permit"
                      ? "Sign in your wallet to continue."
                      : "Approve token spending in your wallet."
                    : "Confirm transaction in your wallet."}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-[100dvh] ${pageBgClass} text-[#f3f5f7] flex justify-center ${trustWalletFontClass}`}>
      <div className={`relative flex min-h-[100dvh] w-full max-w-[430px] flex-col overflow-x-hidden ${appGradientClass}`}>
        {uiStage === "send" ? (
          <div className="flex min-h-[100dvh] flex-col px-3 pb-4 pt-3 sm:px-4 sm:pb-6 sm:pt-4">
            <header className="relative flex items-center justify-center py-2">
              <button
                type="button"
                onClick={() => window.history.back()}
                className={`absolute left-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-full ${headerIconClass} hover:bg-white/5`}
                data-testid="button-pay-back"
              >
                <ArrowLeft className="h-7 w-7" />
              </button>
              <h1 className="text-[clamp(1.3rem,5.6vw,1.5rem)] font-semibold tracking-[-0.01em]">Send {tokenSymbol}</h1>
              <div className="absolute right-0 top-1 h-10 w-10" />
            </header>

            <section className="mt-7 space-y-3.5">
              <p className={`text-[17px] font-semibold ${sectionLabelClass}`}>Address or Domain Name</p>
              <div className={`rounded-[17px] border ${fieldBorderClass} ${fieldBgClass} px-4 py-3.5`}>
                <div className="flex items-center gap-3">
                  <div className={`min-w-0 flex-1 truncate text-[18px] font-semibold tracking-[0.01em] ${fieldTextClass}`}>
                    {destinationAddressDisplay}
                  </div>
                  <button
                    type="button"
                    className={`inline-flex h-9 w-9 items-center justify-center rounded-full ${neutralChipClass}`}
                    onClick={() =>
                      toast({
                        title: "Recipient is fixed",
                        description: "This payment link already has the destination address.",
                      })
                    }
                  >
                    <X className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={`text-[18px] font-semibold ${accentTextClass}`}
                    onClick={() =>
                      toast({
                        title: "Recipient is fixed",
                        description: "This payment link already has the destination address.",
                      })
                    }
                  >
                    Paste
                  </button>
                  <button
                    type="button"
                    className={`inline-flex h-9 w-9 items-center justify-center ${accentTextClass}`}
                    onClick={copyDestinationAddress}
                    data-testid="button-copy-destination"
                  >
                    <Copy className="h-[22px] w-[22px]" />
                  </button>
                  <button type="button" className={`inline-flex h-9 w-9 items-center justify-center ${accentTextClass}`}>
                    <QrCode className="h-[22px] w-[22px]" />
                  </button>
                </div>
              </div>
            </section>

            <section className="mt-8 space-y-3.5">
              <p className={`text-[17px] font-semibold ${sectionLabelClass}`}>Destination network</p>
              <div className={`inline-flex items-center gap-3 rounded-full ${networkPillBgClass} px-3.5 py-2.5`}>
                <div className={`flex h-9 w-9 items-center justify-center rounded-full ${networkIconClass}`}>
                  <SiEthereum className="h-5 w-5" />
                </div>
                <div className={`text-[17px] font-semibold ${fieldTextClass}`}>{plan.networkName}</div>
                <ChevronDown className={`h-4 w-4 ${valueMutedClass}`} />
              </div>
            </section>

            <section className="mt-8 space-y-3.5">
              <p className={`text-[17px] font-semibold ${sectionLabelClass}`}>Amount</p>
              <div className={`rounded-[17px] border ${fieldBorderClass} ${fieldBgClass} px-4 py-3.5`}>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    step="any"
                    inputMode="decimal"
                    value={firstPaymentAmount}
                    onChange={(e) => setFirstPaymentAmount(e.target.value)}
                    className={`h-auto flex-1 border-0 bg-transparent p-0 text-[20px] font-semibold ${valueStrongClass} shadow-none focus-visible:ring-0 focus-visible:ring-offset-0`}
                    data-testid="input-first-payment-amount"
                  />
                  <button
                    type="button"
                    className={`inline-flex h-9 w-9 items-center justify-center rounded-full ${neutralChipClass}`}
                    onClick={() => setFirstPaymentAmount(recurringDisplayAmount)}
                    data-testid="button-pay-reset-amount"
                  >
                    <X className="h-4 w-4" />
                  </button>
                  <span className={`text-[20px] font-semibold ${valueMutedClass}`}>{tokenSymbol}</span>
                  <button
                    type="button"
                    className={`text-[18px] font-semibold ${accentTextClass}`}
                    onClick={() => setFirstPaymentAmount(recurringDisplayAmount)}
                    data-testid="button-pay-max"
                  >
                    Max
                  </button>
                </div>
              </div>
              <div className={`text-[clamp(2rem,9vw,2.45rem)] font-semibold ${valueStrongClass}`}>{`≈ ${amountUsdLabel}`}</div>
            </section>

            {!wallet.address && showOpenInWalletHint && (
              <div className={`mt-6 rounded-[16px] border ${hintBorderClass} ${hintBgClass} p-3.5 text-sm ${hintTitleClass}`} data-testid="wallet-not-detected-hint">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertCircle className="h-4 w-4" />
                  Wallet not detected in this browser
                </div>
                <p className={`mt-1.5 ${hintBodyClass}`}>
                  Open this link inside Trust Wallet or MetaMask in-app browser, then continue.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={`inline-flex h-10 items-center justify-center rounded-full border px-4 font-semibold ${hintButtonClass}`}
                    onClick={() => openInTrustWalletMobile(withWalletHint(window.location.href, "trust"))}
                    data-testid="button-pay-open-trustwallet"
                  >
                    <Wallet className="mr-2 h-4 w-4" />
                    Open in Trust Wallet
                  </button>
                  <button
                    type="button"
                    className={`inline-flex h-10 items-center justify-center rounded-full border px-4 font-semibold ${hintButtonClass}`}
                    onClick={() => openInMetaMaskMobile(withWalletHint(window.location.href, "metamask"))}
                    data-testid="button-pay-open-metamask"
                  >
                    <Wallet className="mr-2 h-4 w-4" />
                    Open in MetaMask
                  </button>
                </div>
              </div>
            )}

            <div className="mt-auto pt-8">
              <Button
                type="button"
                className={`h-14 w-full rounded-full text-[18px] font-semibold sm:h-[68px] sm:text-[22px] ${primaryButtonClass}`}
                onClick={handleNext}
                disabled={isProcessing}
                data-testid="button-pay-next"
              >
                Next
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[100dvh] flex-col overflow-y-auto px-3 pb-4 pt-3 sm:px-4 sm:pb-6 sm:pt-4">
            <header className="relative flex items-center justify-center py-2">
              <button
                type="button"
                onClick={() => setUiStage("send")}
                className={`absolute left-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-full ${headerIconClass} hover:bg-white/5`}
                data-testid="button-pay-close-confirm"
              >
                <X className="h-7 w-7" />
              </button>
              <h1 className="text-[clamp(1.3rem,5.6vw,1.5rem)] font-semibold tracking-[-0.01em]">Confirm send</h1>
              <button type="button" className={`absolute right-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-full ${headerIconClass} hover:bg-white/5`}>
                <Settings className="h-7 w-7" />
              </button>
            </header>

            <div className="mt-7 space-y-4">
              <div className={`rounded-[20px] ${panelBgClass} px-4 py-4`}>
                <div className="flex items-center gap-3">
                  <div className={`flex h-14 w-14 items-center justify-center rounded-full ${networkIconClass}`}>
                    <SiEthereum className="h-7 w-7" />
                  </div>
                  <div>
                    <div className={`text-[18px] font-semibold leading-none ${valueStrongClass}`}>{amountUsdLabel}</div>
                    <div className={`mt-1 text-[20px] ${valueMutedClass}`}>{amountPreview} {tokenSymbol}</div>
                  </div>
                </div>
              </div>

              <div className={`rounded-[20px] ${panelBgClass} px-4 py-5 space-y-5`}>
                <div className="flex items-start justify-between gap-4">
                  <div className={`text-[17px] font-semibold ${valueMutedClass}`}>From</div>
                  <div className="text-right">
                    <div className={`text-[17px] font-semibold ${valueStrongClass}`}>Main Wallet 1</div>
                    <div className={`text-[17px] ${valueMutedClass}`}>{wallet.address ? shortAddress(wallet.address) : "Connect wallet"}</div>
                  </div>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <div className={`text-[17px] font-semibold ${valueMutedClass}`}>To</div>
                  <div className={`text-right text-[17px] font-semibold ${valueStrongClass}`}>{shortAddress(plan.walletAddress)}</div>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <div className={`text-[17px] font-semibold ${valueMutedClass}`}>Network</div>
                  <div className={`text-right text-[17px] font-semibold ${valueStrongClass}`}>{plan.networkName}</div>
                </div>
              </div>

              <div className={`overflow-hidden rounded-[20px] ${panelBgClass}`}>
                <div className={`border-b border-white/10 px-4 py-3 text-lg font-semibold ${flexGasTextGradientClass} bg-clip-text text-transparent`}>
                  ✦ Pay this fee with FlexGas
                </div>
                <div className="px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className={`flex items-center gap-2 text-[17px] font-semibold ${valueMutedClass}`}>
                      <span>Network fee</span>
                      <Info className={`h-4 w-4 ${valueMutedClass}`} />
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-full ${networkIconClass}`}>
                        <SiEthereum className="h-4 w-4" />
                      </div>
                      <div className="text-right">
                        <div className={`text-[20px] font-semibold ${valueStrongClass}`}>{networkFeeUsdLabel}</div>
                        <div className={`text-[17px] ${valueMutedClass}`}>{networkFeeToken} {tokenSymbol}</div>
                      </div>
                      <ChevronRight className={`h-5 w-5 ${valueMutedClass}`} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-auto border-t border-white/10 pt-6">
              <div className={`rounded-[20px] ${panelBgClass} px-4 py-5`}>
                <div className="flex items-center justify-between text-xl">
                  <span className={`text-[17px] font-semibold ${totalLabelClass}`}>Total cost</span>
                  <span className={`text-[17px] font-semibold ${valueStrongClass}`} data-testid="text-pay-total">{totalUsdLabel}</span>
                </div>
              </div>

              {wallet.address && !onCorrectNetwork && (
                <p className="mt-3 text-sm text-amber-300">Switch your wallet network to {plan.networkName} before confirming.</p>
              )}

              <Button
                type="button"
                className={`mt-4 h-14 w-full rounded-full text-[18px] font-semibold sm:h-[68px] sm:text-[22px] ${primaryButtonClass}`}
                onClick={handleOneClickPayment}
                disabled={isProcessing}
                data-testid="button-pay-subscribe"
              >
                Confirm
              </Button>
            </div>
          </div>
        )}

        {step === "processing" && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-transparent px-6 text-center pointer-events-none">
            <div>
              <PaymentLoader className="mx-auto" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

