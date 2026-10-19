import MDXComponents from '@theme-original/MDXComponents';
import {Card, Cards, Steps} from '@site/src/components/Cards';

// Lets every docs page use <Cards>, <Card> and <Steps> without an import.
export default {...MDXComponents, Card, Cards, Steps};
