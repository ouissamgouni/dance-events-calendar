import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ReferralCard from '../components/ReferralCard';

/**
 * Dedicated, linkable "Invite a friend" page — the destination for the
 * "Invite a friend" link sent in notification emails (activity digest,
 * interest match, and event reminder) and the header menu/settings link.
 * Shows the referral QR code plus URL/Copy/Share controls. Does not
 * auto-trigger the native share sheet, since that dialog would cover the
 * QR code as soon as the page loads.
 */
export default function InvitePage() {
    const { user, loading } = useAuth();

    return (
        <>
            <Helmet>
                <title>Invite a friend</title>
            </Helmet>
            <div className="max-w-md mx-auto px-4 py-10">
                {loading ? null : !user ? (
                    <div className="w-full border border-blue-100 bg-blue-50 px-6 py-5 text-sm text-blue-700">
                        <p className="mb-3">Sign in first to invite a friend.</p>
                        <Link
                            to="/login?next=/invite"
                            className="inline-block bg-blue-500 text-white hover:bg-blue-600 px-4 py-2 text-sm font-medium transition"
                        >
                            Sign in
                        </Link>
                    </div>
                ) : (
                    <ReferralCard />
                )}
            </div>
        </>
    );
}
