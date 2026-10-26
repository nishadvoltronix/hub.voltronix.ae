import { LoginForm } from "@/components/login-form";
import Image from "next/image";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";

export const dynamic = "force-dynamic";
export default async function LoginPage() {
  const jar = await cookies();
  // Public login rendering needs no backend lookup when there is no session.
  // A supplied cookie is still validated by the normal authentication service.
  if ((jar.has("crm_session") || jar.has("__Host-crm_session")) && await currentUser()) redirect("/");
  return (
    <main className="auth-main loginbg crm-login">
      <div className="auth-wrapper v2"><div className="auth-sidecontent">
        <div className="d-flex justify-content-center align-items-center vh-100">
          <div className="card p-4 crm-login-card"><div className="card-body">
            <div className="text-center"><Image src="/legacy/assets/images/voltronix_logo.png" alt="Voltronix" width={407} height={75} unoptimized className="crm-login-logo" priority /></div>
            <h1 className="h5 text-center f-w-500 mt-4 mb-3"><i>Login to your Workspace</i></h1>
            <LoginForm />
          </div></div>
        </div>
      </div></div>
    </main>
  );
}
