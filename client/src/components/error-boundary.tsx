import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class GlobalErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Uncaught error:", error, errorInfo);
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen bg-[#0f0f10] text-white flex items-center justify-center p-6">
                    <div className="max-w-md w-full bg-[#1c1c1e] rounded-2xl p-8 border border-white/10 text-center shadow-2xl">
                        <div className="mx-auto w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-6">
                            <AlertCircle className="w-10 h-10 text-red-500" />
                        </div>
                        <h1 className="text-2xl font-bold mb-4">Application Error</h1>
                        <p className="text-gray-400 mb-6 leading-relaxed">
                            Something went wrong while loading this page. This often happens if the wallet browser encounters a JavaScript error.
                        </p>
                        <div className="bg-black/20 rounded-lg p-4 mb-8 text-left overflow-auto max-h-40">
                            <code className="text-sm text-red-400 break-all">
                                {this.state.error?.message || "Unknown error"}
                            </code>
                        </div>
                        <div className="flex flex-col gap-3">
                            <Button
                                onClick={() => window.location.reload()}
                                className="bg-white text-black hover:bg-gray-200 py-6 rounded-xl font-bold text-lg"
                            >
                                <RefreshCw className="w-5 h-5 mr-2" />
                                Reload Page
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() => window.location.href = "/"}
                                className="border-white/20 hover:bg-white/5 py-6 rounded-xl text-gray-400"
                            >
                                Return Home
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
