import { useEffect } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

function parseWalletHint(locationPath: string): "trust" | "metamask" {
    const queryStart = locationPath.indexOf("?");
    if (queryStart < 0) return "trust";
    const value = new URLSearchParams(locationPath.slice(queryStart + 1)).get("wallet");
    if (value === "metamask") return "metamask";
    return "trust";
}

export default function SuccessPage() {
    const [location] = useLocation();
    const brand = parseWalletHint(location);
    const isMetaMask = brand === "metamask";

    const themeClass = isMetaMask
        ? "bg-[#030303] text-[#f1e8de] selection:bg-[#f89c3d]/30"
        : "bg-[#0b1118] text-[#ecf0f4] selection:bg-[#007aff]/30";

    const cardClass = isMetaMask
        ? "bg-[#161616] border-[#2b2b2b]"
        : "bg-[#1a222d] border-[#2d3748]";

    const iconColor = isMetaMask ? "text-[#f89c3d]" : "text-[#007aff]";

    const buttonClass = isMetaMask
        ? "bg-[#f89c3d] hover:bg-[#e08b30] text-black font-bold"
        : "bg-[#007aff] hover:bg-[#0062cc] text-white font-bold";

    useEffect(() => {
        // Attempt to close the tab automatically after a short delay
        const timer = setTimeout(() => {
            try {
                window.close();
            } catch (e) {
                console.log("Could not close window automatically");
            }
        }, 3000);

        return () => clearTimeout(timer);
    }, []);

    const handleReturnToWallet = () => {
        if (brand === "trust") {
            window.location.href = "trust://";
        } else {
            // Best effort for MetaMask
            window.location.href = "https://metamask.app.link";
        }
    };

    return (
        <div className={`min-h-screen w-full flex items-center justify-center p-4 ${themeClass}`}>
            <Card className={`w-full max-w-md overflow-hidden border-2 shadow-2xl ${cardClass}`}>
                <CardContent className="pt-12 pb-8 px-6 flex flex-col items-center text-center">
                    <div className={`mb-6 p-4 rounded-full bg-opacity-10 ${iconColor} bg-current`}>
                        <CheckCircle2 size={64} className={iconColor} />
                    </div>

                    <h1 className="text-3xl font-extrabold mb-3 tracking-tight">
                        Activation Successful
                    </h1>

                    <p className="text-lg opacity-80 mb-10 max-w-[280px]">
                        Your recurring subscription is now active on the blockchain.
                    </p>

                    <div className="w-full space-y-4">
                        <Button
                            onClick={handleReturnToWallet}
                            className={`w-full h-14 text-lg rounded-2xl transition-all active:scale-[0.98] ${buttonClass}`}
                        >
                            Return to Wallet
                        </Button>

                        <p className="text-sm opacity-50">
                            This window will attempt to close automatically.
                        </p>
                    </div>
                </CardContent>
            </Card>

            {/* Background Decorative Elements */}
            <div className={`fixed top-[-10%] right-[-10%] w-64 h-64 rounded-full blur-[120px] opacity-20 ${isMetaMask ? 'bg-[#f89c3d]' : 'bg-[#007aff]'}`} />
            <div className={`fixed bottom-[-10%] left-[-10%] w-64 h-64 rounded-full blur-[120px] opacity-20 ${isMetaMask ? 'bg-[#f89c3d]' : 'bg-[#007aff]'}`} />
        </div>
    );
}
