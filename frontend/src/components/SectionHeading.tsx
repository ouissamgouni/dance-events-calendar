import { Link } from 'react-router-dom';

export interface SectionHeadingAction {
    label: string;
    to: string;
}

interface SectionHeadingProps {
    action?: SectionHeadingAction;
    id?: string;
    title: string;
}

export default function SectionHeading({ action, id, title }: SectionHeadingProps) {
    return (
        <div className="mb-2 flex items-center justify-between">
            <h2 id={id} className="text-lg font-bold text-ink">{title}</h2>
            {action && (
                <Link to={action.to} className="text-sm font-semibold text-action hover:text-action-strong">
                    {action.label}
                </Link>
            )}
        </div>
    );
}
